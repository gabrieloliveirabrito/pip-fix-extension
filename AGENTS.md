# Instruções do projeto

## Execução e economia de contexto

- Responda em português. Execute o trabalho solicitado e reporte resultado, validação e limitações de forma breve.
- Comece pela mudança pedida, `git status --short` e buscas específicas com `rg`. Leia apenas os trechos necessários; evite despejar arquivos grandes, lockfiles, `node_modules/` ou `dist/` no contexto.
- Este arquivo é o mapa inicial. Para problemas de PiP no Firefox, leia também `docs/firefox-pip.md`. Para instalação e recarga manual, consulte `docs/instalar-firefox.md`.
- Prefira código, logs fornecidos e documentação local para investigar o comportamento existente. Consulte fontes oficiais externas quando precisar confirmar APIs, compatibilidade, detalhes internos do Firefox ou informações sujeitas a mudança. Não repita pesquisas já documentadas sem uma dúvida concreta; registre a fonte, versão e conclusão quando pesquisar algo novo.
- Separe observação, hipótese e confirmação. Não transforme uma heurística ou resultado de teste simulado em garantia sobre o navegador real.
- Atualize a documentação relevante quando uma descoberta invalidar o fluxo descrito. Guarde fatos duráveis, comandos e pendências; não transcrições de conversa nem logs extensos.
- Evite novas dependências, refatorações amplas, instalações e alterações em lockfiles para correções locais. Preserve mudanças existentes do usuário.
- Ao criar um PR, use uma branch dedicada e deixe essa branch ativa no workspace ao concluir. Não faça merge nem retorne à branch base automaticamente. Se publicação ou autenticação estiver bloqueada, preserve o trabalho e informe o que falta.
- A branch padrão e base de novos trabalhos/PRs é `development`. `main` recebe as promoções para versão publicada.
- Merges em `development` sincronizam `VERSION`; merges em `main` incrementam o patch e sincronizam `VERSION`, `package.json`, `manifest.json` e as versões do pacote raiz em `package-lock.json`. A automação está em `.github/workflows/version.yml`; não faça bump manual para duplicar o trabalho do CI. Veja `docs/versionamento.md`.

## Mapa do código

Extensão Manifest V3 para manter o PiP do YouTube Music. TypeScript estrito, React e Tailwind na configuração.

| Arquivo | Responsabilidade |
| --- | --- |
| `src/pip-keep.ts` | Script no mundo MAIN: detecção PiP, proteção do vídeo, hooks DOM/mídia, troca de vídeo e heurísticas Firefox. Arquivo grande: localize funções com `rg -n` antes de ler trechos. |
| `src/bridge.ts` | Ponte entre mensagens da página e storage da extensão; estado ativado e gravação dos logs. |
| `src/shared.ts` | Tipos, validação, classificação e retenção dos logs; chaves do storage. |
| `src/background.ts` | Ícone abre a configuração empacotada. |
| `src/options/` | Interface React de configuração e visualização dos logs. |
| `src/options-bridge.ts` | Ponte para a página de desenvolvimento em localhost. |
| `src/dom-pip.d.ts` | Declarações de APIs PiP adicionais; declaração não prova disponibilidade em execução. |
| `scripts/bundle.mjs` | esbuild dos scripts e cópia do manifest para `dist/`. |
| `vite.config.ts` | Build da interface em `dist/options/`, com caminhos relativos e nomes estáveis. |
| `manifest.json` | Permissões, scripts, mundos de execução e versão mínima declarada do Firefox (140). |

## Build e validação proporcional

- Documentação apenas: confira conteúdo, caminhos e comandos; não rode build.
- Scripts da extensão: `node scripts/bundle.mjs` e `npx --no-install tsc --noEmit`.
- Mudanças no PiP Firefox: rode também `node scripts/test-firefox-pause.mjs`. É uma regressão simulada, não um teste de integração do navegador.
- Interface ou configuração Vite: `npm run build` e `npx --no-install tsc --noEmit`.
- Para entregar um pacote completo ou quando `dist/` estiver ausente: `npm run build`.
- Use as dependências locais instaladas. Não reinstale nem troque o gerenciador/lockfile sem necessidade.
- Não crie testes para alterações triviais de texto. Para mudanças de comportamento, valide o cenário de falha e os efeitos colaterais relevantes. Não repita verificações aprovadas sem mudanças ou nova evidência.

## Vite e desenvolvimento no Firefox

- O fluxo normal usa arquivos empacotados em `dist/`; não precisa de servidor Vite na porta 5173.
- `npm run dev` mantém esbuild e `vite build --watch`; não abre o Firefox. Só inicie watchers se o trabalho exigir desenvolvimento contínuo e não duplique processos existentes.
- Para uma correção pontual, prefira build único. Se alterar apenas `pip-keep.ts`, não recompile a interface sem necessidade.
- `npm run dev:firefox` abre o Firefox temporário via web-ext. Não execute automaticamente durante validação no perfil do usuário.
- Para testar no Firefox já aberto: recarregar o complemento em `about:debugging#/runtime/this-firefox` e atualizar a aba do YouTube Music. Veja o guia de instalação para detalhes.
- Não edite `dist/` manualmente. Preserve `base: "./"`, a configuração empacotada e a separação entre MAIN e APIs da extensão.
