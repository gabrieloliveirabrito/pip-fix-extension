# Instalar no Firefox

A extensão precisa do Firefox 140 ou mais novo. O build usa Node.

## Desenvolvimento no Firefox da sua conta

Na pasta do projeto:

```bash
pnpm install
pnpm run build
```

Depois, no Firefox em que você já está logado:

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar complemento temporário…**.
3. Escolha o arquivo `dist/manifest.json`.

Para desenvolver com recarga dos scripts e da tela de configuração:

```bash
pnpm run dev
```

Isso recompila `dist/` (scripts + `dist/options`) em watch. **Não abre Firefox e não usa o servidor Vite.** Depois de cada mudança, use **Recarregar** no `about:debugging`. A aba do YouTube Music precisa de refresh para pegar o `pip-keep.js` novo.

O ícone da extensão abre a configuração empacotada em `dist/options` (sem depender de `options-bridge` / localhost).

Se quiser o Firefox temporário antigo do `web-ext`:

```bash
pnpm run dev:firefox
```

O switch **Ativado** começa ligado.

### PiP pelo botão do Firefox

O botão da barra, o atalho e o menu de contexto não disparam `enterpictureinpicture`. A extensão detecta sozinha por:

1. `userActivation` renovada sem clique na página (o Firefox faz isso ao abrir o player)
2. aba `visible` sem foco no documento (a janela PiP recebe `autoFocus`)
3. ao fechar: pause no vídeo

Nos logs: `pip-firefox abre …`, `pip-abre`, `pip-firefox fecha`, `pip-fecha`. Em dúvida, `pip-firefox-probe` mostra blur/foco.

Esse carregamento temporário some quando o navegador fecha. Para usar de novo, carregue `dist/manifest.json` outra vez.

A publicação na Mozilla fica de fora deste guia.
