# PiP no Firefox: referência de investigação

Leia este arquivo ao alterar o comportamento do PiP no Firefox. Consulte o código atual se algum detalhe divergir: este documento não substitui a implementação.

## Limites e decisões do projeto

- O PiP nativo aberto pela interface do Firefox é tratado separadamente do PiP detectável pelas APIs da página. O código usa `userActivation`, foco e sinais adicionais como heurísticas de abertura. Não trate esses sinais como prova isolada.
- O miniplayer do YouTube Music não comprova PiP do navegador. No Firefox, o código desativa a inferência por layout do vídeo para evitar falsos positivos.
- `isCloningElementVisually`, eventos `Moz*`, seletores e APIs opcionais podem não estar acessíveis à página. Verifique a disponibilidade em execução; os tipos em `src/dom-pip.d.ts` não garantem suporte.
- Pausa, perda ou retorno de foco, `readyState=0` e largura zero podem acontecer durante reprodução normal ou troca de faixa. Não use esses sinais isoladamente para declarar que o usuário fechou o PiP.
- O fechamento explícito é tratado por `leavepictureinpicture` e, quando recebido, `MozStopPictureInPicture`. Sem sinal de saída, a sessão pode permanecer indicada como ativa depois que a janela fechar. Essa é uma limitação conhecida.

## Evidência fornecida em 06/11/2026

O log do usuário registrou às 18:34:02:

```text
video-pause: connected=true paused=true readyState=4 videoWidth=854
pip-firefox-probe: close-pendente pausa-blur paused=true foco=false
pip-firefox: fecha pausa-blur
pip-fecha / pip-leave / desativado: pausa-blur
```

Isso comprova que a própria heurística de pausa liberou a proteção; não comprova que a janela nativa fechou naquele instante. A correção removeu o fechamento inferido de pausa/foco/poll e registra `pausa-preservada` para o vídeo protegido.

O mesmo log apresentou `NotAllowedError` ao tentar transferir o PiP após remoção do vídeo. A correção da pausa não resolve nem confirma a causa desse erro. A transferência no Firefox continua dependendo de validação real.

## Onde investigar

Use `rg -n` em `src/pip-keep.ts` para localizar:

- Abertura e heurísticas: `armFirefoxPip`, `watchFirefoxPip`, `onFirefoxFocusChange`.
- Saída e proteção: `disarmFirefoxPip`, `onLeave`, `releasePipSession`, `noteFirefoxPause`.
- Troca de vídeo: `handoff`, `considerHandoff`, `guardedNeedsSwap`, `parkGuardedForRemoval`.
- Mensagens e estado: `announcePipReopen`, `syncPipUiHint`, `publishPlayback`.

Leia o log em ordem cronológica; o texto copiado da interface pode vir do mais recente para o mais antigo. Diferencie fechamento observado do navegador de eventos `pip-fecha` gerados pelo estado interno da extensão.

## Validação

`node scripts/test-firefox-pause.mjs` cobre pausa sem foco, retorno de foco, polls repetidos e pausa em outro vídeo. Não abre o Firefox nem valida transferência de janela.

No navegador, verificar: abrir PiP, pausar por alguns segundos, retomar, alternar foco, trocar faixa com substituição do vídeo, fechar pelo X e abrir novamente. Registrar versão do Firefox, modo música/vídeo, horário da falha e eventos próximos. Não afirmar que estes cenários passaram sem executá-los.

Ao confirmar comportamento externo por pesquisa, acrescentar aqui a URL oficial, versão consultada e conclusão útil. Evitar repetir pesquisa ampla sobre Firefox a cada correção.
