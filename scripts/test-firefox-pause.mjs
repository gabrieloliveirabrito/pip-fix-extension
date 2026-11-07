import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync('src/pip-keep.ts', 'utf8');
const ast = ts.createSourceFile('pip-keep.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['noteFirefoxPause', 'onFirefoxFocusChange', 'watchFirefoxPip']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, names.size);
const video = { paused: true };
let focused = false;
const logs = [];
const context = vm.createContext({
  firefoxPip: true, guarded: video, enabled: true, firefoxHadFocus: false,
  firefoxLastActivation: false, firefoxVisibility: 'visible',
  document: { hasFocus: () => focused, visibilityState: 'visible' },
  HTMLVideoElement: Object,
  isFirefoxBrowser: () => true, firefoxActivationOn: () => false,
  pickPrimaryPlayerVideo: () => video, firefoxCloneOn: () => false,
  log: (...args) => logs.push(args), detailOf: () => 'paused=true',
  scheduleFirefoxOpenFromBlur: () => {},
  disarmFirefoxPip: () => assert.fail('Pause/focus must preserve PiP'),
});
vm.runInContext(ts.transpile(functions.join('\n')), context);
context.noteFirefoxPause(video);
assert.equal(context.firefoxPip, true);
assert.match(logs[0][1], /pausa-preservada/);
focused = true;
context.onFirefoxFocusChange();
for (let i = 0; i < 100; i++) context.watchFirefoxPip();
assert.equal(context.firefoxPip, true);
assert.equal(context.firefoxHadFocus, true);
context.noteFirefoxPause({ paused: true });
assert.equal(logs.length, 1, 'Unrelated video pause should be ignored');
console.log('Firefox regression passed: pause while blurred, focus return, repeated polls, unrelated video.');
