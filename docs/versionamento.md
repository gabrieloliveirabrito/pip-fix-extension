# Branches e versões

`development` é a branch padrão do repositório e a base dos PRs de trabalho. Promoções de código pronto vão de `development` para `main`. Ao concluir um PR, manter a branch dele ativa no workspace.

O arquivo `VERSION` contém apenas a versão numérica, por exemplo `1.0.0`, seguida de uma quebra de linha.

O workflow `.github/workflows/version.yml` usa `pull_request_target: closed` com verificação de merge e checkout exclusivo da branch base já integrada, inclusive para PRs vindos de forks. Ele nunca executa o head de um PR aberto com token de escrita. Roda depois que um PR é efetivamente mergeado:

- Em `development`, cria ou sincroniza `VERSION` com a maior versão conhecida entre os arquivos atuais, a publicação em `main` e o último commit de versionamento. Não incrementa a versão nem altera `package.json` nessa etapa.
- Em `main`, incrementa o patch da maior versão conhecida (`1.0.0` → `1.0.1`) e sincroniza `VERSION`, `package.json`, `manifest.json` e a versão do pacote raiz no `package-lock.json`. Atualizar o manifest faz a versão do pacote da extensão acompanhar a publicação. As versões das dependências ficam intactas; o lockfile pnpm atual não possui uma versão de pacote raiz para atualizar.

Cada merge é identificado pelo SHA no commit automático, para permitir reexecutar um workflow sem duplicar o bump. Se houver push concorrente, a execução busca a branch atual e recalcula antes de tentar publicar novamente. O histórico automático evita redução de versão quando um PR traz arquivos antigos. PR fechado sem merge e push direto não geram bump.

O commit usa `GITHUB_TOKEN` com `contents: write`. O push desse token não dispara recursivamente outros workflows de push. Se forem adicionadas proteções de branch que bloqueiem commits do bot, será necessário adaptar a publicação para essas regras.

A automação precisa estar integrada na branch padrão para receber seus eventos. O PR de configuração já inclui `VERSION` inicial; os merges seguintes passam a usar a regra automática. O workflow separado `version-tests.yml` valida o script nos PRs com permissão somente de leitura.

Após promover para `main`, sincronize `main` de volta em `development` antes de iniciar a próxima publicação, para trazer também as versões do pacote e do manifest. Resolva conflitos de versão preservando a versão publicada mais recente.

Validação local, sem instalar dependências nem iniciar Vite:

```bash
node --test scripts/test-version.mjs
```

Os testes usam diretórios temporários. `node scripts/version.mjs development` e `node scripts/version.mjs main` alteram os arquivos locais; são comandos da automação, não verificações sem efeitos.

Referências: [eventos de workflow e merges](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [permissões do workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [comportamento do GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token).
