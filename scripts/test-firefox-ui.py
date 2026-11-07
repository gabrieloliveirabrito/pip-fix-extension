"""Smoke-test the packaged extension in an isolated headless Firefox (stdlib only).

Build first: npm run build
Run: python scripts/test-firefox-ui.py [path/to/firefox]
Never attaches to, reloads or changes the user's existing Firefox profile.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile


class Marionette:
    def __init__(self, sock):
        self.sock = sock
        self.counter = 0
        self.receive()

    def receive(self):
        header = b""
        while not header.endswith(b":"):
            chunk = self.sock.recv(1)
            if not chunk:
                raise RuntimeError("Firefox closed the automation connection")
            header += chunk
        length = int(header[:-1])
        body = b""
        while len(body) < length:
            chunk = self.sock.recv(length - len(body))
            if not chunk:
                raise RuntimeError("Incomplete Firefox response")
            body += chunk
        return json.loads(body)

    def command(self, command, parameters=None):
        self.counter += 1
        payload = json.dumps([0, self.counter, command, parameters or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        result = self.receive()
        assert result[1] == self.counter
        if result[2]:
            raise RuntimeError(f"{command}: {result[2]}")
        value = result[3]
        return value.get("value") if isinstance(value, dict) and "value" in value else value

    def js(self, script, args=None):
        return self.command("WebDriver:ExecuteScript", {
            "script": script, "args": args or [], "newSandbox": False,
            "sandbox": None, "line": 1, "filename": "pip-ui-smoke-test",
        })

    def async_js(self, script, args=None):
        wrapped = "const done=arguments[arguments.length-1]; Promise.resolve((async()=>{" + script + "})()).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));"
        result = self.command("WebDriver:ExecuteAsyncScript", {
            "script": wrapped, "args": args or [], "newSandbox": False,
            "sandbox": None, "line": 1, "filename": "pip-ui-smoke-test",
        })
        if not result["ok"]:
            raise RuntimeError(result.get("error"))
        return result.get("value")

    def wait(self, expression, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            result = self.js("return " + expression)
            if result:
                return result
            time.sleep(0.1)
        raise AssertionError(f"Timed out: {expression}")

    def click(self, text):
        self.wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===" + json.dumps(text) + "&&!b.disabled)")
        assert self.js("const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===arguments[0]);if(!b)throw Error('Button missing: '+arguments[0]);b.click();return true", [text])

    def append(self, rows):
        for offset in range(0, len(rows), 50):
            result = self.async_js("return await chrome.runtime.sendMessage({source:'pip-log-store',command:{type:'append',entries:arguments[0]}})", [rows[offset:offset + 50]])
            assert result["ok"], result


def run():
    root = Path(__file__).resolve().parents[1]
    firefox = sys.argv[1] if len(sys.argv) > 1 else (shutil.which("firefox") or r"C:\Program Files\Mozilla Firefox\firefox.exe")
    assert (root / "dist/manifest.json").is_file(), "Run npm run build first"
    temporary = Path(tempfile.mkdtemp(prefix="pip-firefox-ui-" )).resolve()
    assert temporary.parent == Path(tempfile.gettempdir()).resolve() and temporary.name.startswith("pip-firefox-ui-")
    profile = temporary / "profile"
    profile.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    uuid = "d77af8a0-1111-4444-9999-0123456789ab"
    prefs = {
        "marionette.port": port, "browser.shell.checkDefaultBrowser": False,
        "browser.startup.homepage_override.mstone": "ignore", "browser.aboutwelcome.enabled": False,
        "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
        "toolkit.telemetry.reportingpolicy.firstRun": False,
        "extensions.webextensions.uuids": json.dumps({"pip-keep@youtube-music": uuid}),
    }
    (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()), encoding="utf-8")
    package = temporary / "extension.xpi"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in (root / "dist").rglob("*"):
            if path.is_file() and path.suffix not in [".png"]:
                archive.write(path, path.relative_to(root / "dist").as_posix())
    logfile = (temporary / "firefox.log").open("w", encoding="utf-8")
    process = subprocess.Popen([firefox, "-headless", "-no-remote", "-marionette", "--remote-allow-system-access", "-profile", str(profile)],
        stdout=logfile, stderr=subprocess.STDOUT, env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"}, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    client = None
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                sock = socket.create_connection(("127.0.0.1", port), timeout=1)
                sock.settimeout(20)
                client = Marionette(sock)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Firefox automation did not start")
                time.sleep(0.2)
        capabilities = client.command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
        print("Firefox session:", capabilities.get("capabilities", {}).get("browserVersion", "ready"), flush=True)
        client.command("Addon:Install", {"path": str(package), "temporary": True})
        client.command("WebDriver:Navigate", {"url": f"moz-extension://{uuid}/options/index.html"})
        client.wait("document.querySelector('h1')?.textContent.includes('Linha do tempo')")
        client.wait("!document.body.innerText.includes('Carregando registros')")
        labels = client.js("return Array.from(document.querySelectorAll('select')[2].options).map(option=>option.textContent)")
        assert labels == ["Todas as categorias", "PiP (0)", "Remoções (0)", "Mídia (0)", "Extensão (0)", "Outros (0)"], labels

        now = int(time.time() * 1000)
        rows = [{"id": f"fixture-{i}", "sessionId": "session-A" if i % 2 else "session-B", "sequence": i,
            "videoId": "video-1" if i % 3 else "video-2", "ts": now + i,
            "event": "pip-request-erro" if i == 159 else "video-playing", "detail": "NotAllowedError" if i == 159 else "fixture",
            "evidence": "result" if i == 159 else "observed", "origin": "ui-test",
            **({"outcome": "failed"} if i == 159 else {})} for i in range(260)]
        client.append(rows)
        client.wait("document.querySelectorAll('[data-row-key]').length===200")
        assert client.js("return !!document.querySelector('table')"), "Compact table is the default"
        assert client.js("return document.querySelector('[data-row-key]').getBoundingClientRect().height") < 40
        client.js("document.querySelector('details').open=true")
        assert "fixture-259" in client.js("return document.querySelector('details').innerText")
        client.js("document.querySelector('details').open=false")
        image = client.command("WebDriver:TakeScreenshot", {"full": True})
        (root / "dist/log-table-desktop.png").write_bytes(base64.b64decode(image))
        client.click("Pausar visualização")
        later = {**rows[-1], "id": "fixture-later", "sequence": 260, "ts": now + 600, "detail": "new-event-while-paused"}
        client.append([later])
        client.wait("document.body.innerText.includes('1 novos registros recebidos')")
        assert client.js("return document.querySelectorAll('[data-row-key]').length") == 200
        client.click("Retomar visualização")
        client.wait("document.querySelector('[data-row-key]')?.dataset.rowKey==='fixture-later:0'")

        anchor = client.js("const v=document.querySelector('[data-log-viewport]');v.scrollTop=v.scrollHeight-v.clientHeight-30;v.dispatchEvent(new Event('scroll'));const top=v.getBoundingClientRect().top;const r=Array.from(v.querySelectorAll('[data-row-key]')).find(r=>r.getBoundingClientRect().bottom>top);return {key:r.dataset.rowKey,offset:r.getBoundingClientRect().top-top}")
        client.append([{**later, "id": "fixture-after-scroll", "sequence": 261}])
        client.wait("document.body.innerText.includes('262 registros encontrados')")
        offset = client.js("const r=Array.from(document.querySelectorAll('[data-row-key]')).find(r=>r.dataset.rowKey===arguments[0]);return r.getBoundingClientRect().top-document.querySelector('[data-log-viewport]').getBoundingClientRect().top", [anchor["key"]])
        assert abs(offset - anchor["offset"]) < 2, (anchor, offset)
        client.click("Voltar aos mais recentes")
        client.wait("document.querySelector('[data-log-viewport]').scrollTop===0")

        client.click("Linha do tempo")
        client.wait("!!document.querySelector('ol')&&!document.querySelector('table')")

        def select(index, value):
            client.js("const select=document.querySelectorAll('select')[arguments[0]];select.value=arguments[1];select.dispatchEvent(new Event('change',{bubbles:true}))", [index, value])

        select(0, "session-A")
        client.wait("document.querySelectorAll('[data-row-key]').length===132")
        select(1, "session-A/video-1")
        client.wait("document.querySelectorAll('[data-row-key]').length===89")
        assert client.js("return Array.from(document.querySelectorAll('pre')).every(pre=>{const entry=JSON.parse(pre.textContent);return entry.sessionId==='session-A'&&entry.videoId==='video-1'})")
        select(1, "all")
        select(3, "errors")
        client.wait("document.querySelectorAll('[data-row-key]').length===1")
        client.click("Remover filtros")
        client.wait("document.querySelectorAll('[data-row-key]').length===200")
        client.click("Carregar mais 200 (200 de 262)")
        client.wait("document.querySelectorAll('[data-row-key]').length===262")

        client.js("const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'NotAllowedError');input.dispatchEvent(new Event('input',{bubbles:true}));")
        client.wait("document.querySelectorAll('[data-row-key]').length===1")
        assert "Solicitação de abertura falhou" in client.js("return document.querySelector('[data-log-viewport]').innerText")
        client.js("document.querySelector('details').open=true")
        assert "NotAllowedError" in client.js("return document.querySelector('details').innerText")

        # Capture downloads inside this isolated page to verify the actual export buttons.
        client.js("window.testExports=[];HTMLAnchorElement.prototype.click=function(){window.testExports.push({url:this.href,name:this.download})}")
        client.click("Filtrados · JSON")
        client.wait("window.testExports.length===1")
        exported = client.async_js("return await (await fetch(window.testExports[0].url)).json()")
        assert len(exported["logs"]) == 1 and exported["logs"][0]["detail"] == "NotAllowedError"
        client.click("Histórico completo · Texto")
        text = client.async_js("return await (await fetch(window.testExports[1].url)).text()")
        assert "fixture-later" in text and "NotAllowedError" in text
        client.click("Remover filtros")
        client.wait("document.body.innerText.includes('262 registros encontrados')")
        client.wait("document.querySelectorAll('[data-row-key]').length===200")
        client.js("document.querySelector('input[type=search]').focus()")
        client.command("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "keyboard", "actions": [{"type": "keyDown", "value": "\ue004"}, {"type": "keyUp", "value": "\ue004"}]}]})
        assert client.js("return document.activeElement===document.querySelector('select')"), "Keyboard Tab must reach the session filter"
        client.command("WebDriver:SetWindowRect", {"width": 1280, "height": 1000})
        image = client.command("WebDriver:TakeScreenshot", {"full": True})
        (root / "dist/log-timeline-desktop.png").write_bytes(base64.b64decode(image))
        client.command("WebDriver:SetWindowRect", {"width": 390, "height": 900})
        time.sleep(0.2)
        assert client.js("return document.documentElement.scrollWidth<=window.innerWidth"), "Horizontal overflow at mobile width"
        image = client.command("WebDriver:TakeScreenshot", {"full": True})
        (root / "dist/log-timeline-mobile.png").write_bytes(base64.b64decode(image))

        # An action's failed runtime/storage request stays inline, preserving history.
        client.js("window.originalSendMessage=chrome.runtime.sendMessage;chrome.runtime.sendMessage=function(message){if(message.command?.type==='enabled')return Promise.reject(new Error('Falha simulada de storage'));return window.originalSendMessage.apply(this,arguments)};document.querySelector('[role=switch]').click()")
        client.wait("document.body.innerText.includes('Falha simulada de storage')")
        assert client.js("return document.querySelectorAll('[data-row-key]').length") == 200
        assert client.js("return document.querySelector('[role=switch]').getAttribute('aria-checked')") == "true"
        client.js("chrome.runtime.sendMessage=window.originalSendMessage")
        client.click("Tentar ler novamente")
        client.wait("!document.body.innerText.includes('Falha simulada de storage')")
        client.click("Limpar histórico")
        client.wait("document.querySelectorAll('[data-row-key]').length===0")
        client.append([{**later, "id": "fixture-after-clear"}])
        client.wait("document.querySelectorAll('[data-row-key]').length===1")
        client.js("document.querySelector('[role=switch]').click()")
        client.wait("document.querySelector('[role=switch]').getAttribute('aria-checked')==='false'")
        client.command("WebDriver:Navigate", {"url": f"moz-extension://{uuid}/options/index.html"})
        client.wait("!!document.querySelector('ol')&&!document.querySelector('table')")
        client.click("Tabela compacta")
        client.command("WebDriver:Navigate", {"url": f"moz-extension://{uuid}/options/index.html"})
        client.wait("!!document.querySelector('table')")
        print("PASS: compact table density, shared pause/scroll, layout persistence, packaged storage/runtime, live updates, pause/resume, scroll anchoring, search, details, JSON/text exports, responsive layout, inline errors, clear and toggle.", flush=True)
    except Exception:
        logfile.flush()
        print((temporary / "firefox.log").read_text(encoding="utf-8", errors="replace")[-2500:], file=sys.stderr)
        raise
    finally:
        if client:
            try:
                client.command("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
            client.sock.close()
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        logfile.close()
        # Delete only the verified, dedicated temporary directory created above.
        assert temporary.parent == Path(tempfile.gettempdir()).resolve() and temporary.name.startswith("pip-firefox-ui-")
        shutil.rmtree(temporary, ignore_errors=True)


if __name__ == "__main__":
    run()
