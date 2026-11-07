# Diagnóstico do PiP

A configuração empacotada mostra uma linha do tempo com eventos recentes primeiro, filtros por sessão, vídeo, categoria, falhas e ações, e busca nos dados técnicos. Os detalhes recolhidos incluem o registro bruto. Exportação JSON/texto usa ordem de recebimento, do mais antigo para o mais recente, e inclui todo o escopo escolhido, independentemente da paginação visual.

O seletor **Tabela compacta / Linha do tempo** alterna a apresentação dos mesmos registros. A tabela é o padrão, com uma linha por evento, cabeçalho fixo e detalhes expansíveis; em janelas estreitas, a rolagem horizontal fica dentro da tabela. A preferência é lembrada localmente. Filtros, pausa, contagens e exportação são compartilhados pelos dois modos.

**Pausar visualização** congela a tela e permite continuar examinando os dados. A coleta permanece ativa; o contador de novos registros considera recebimento, não somente o tamanho da lista, pois a retenção pode descartar entradas. Exportações feitas durante a pausa usam o histórico congelado. **Retomar** mostra o histórico disponível naquele momento.

São renderizados 200 registros por vez, ampliáveis pelo botão de carregar mais. Enquanto o usuário lê uma posição anterior, a janela de linhas acompanha o registro de referência mesmo quando chegam novos eventos. **Voltar aos mais recentes** retorna ao início atualizado. Registros removidos pela retenção deixam de estar disponíveis.

## Significado dos registros

- **Observado:** evento recebido ou estado medido; a origem e o resultado indicam o alcance da evidência.
- **Inferido:** indício ou estado interno da extensão. Não confirma a janela do navegador.
- **Tentativa:** solicitação iniciada. Não comprova sucesso.
- **Resultado / Solicitação concluída:** promessa de abertura/transferência resolveu. Não comprova que a janela continua aberta.
- **Falhou:** rejeição ou erro, incluindo `NotAllowedError`.
- **Preservado:** elemento estacionado ou proteção mantida durante pausa. Não significa reabertura.
- **Sinal confirmado:** API específica de PiP ou evento nativo confiável observado naquele instante. Eventos sintéticos não recebem essa confirmação.

O resumo é relativo à sessão escolhida (ou a todas), independentemente de busca/categoria. Operações identificadas são contadas uma vez, ainda que produzam vários eventos. O último sinal tem horário; não é um monitor da existência atual da janela. Registros antigos continuam marcados como legados, sem sessão ou confirmação inventadas.

## Dados e transporte

`LogEntry` preserva `ts`, `event`, `detail`. Campos opcionais: `id`, `sessionId`, `sequence`, `videoId`, `operationId`, `origin`, `evidence`, `outcome`, `state`. Sessões identificam o carregamento da página; os IDs de vídeo valem dentro da sessão. O estado inclui conexão ao DOM, pausa, término, prontidão, dimensões, foco e visibilidade. URLs da mídia e tokens não são coletados.

O mundo MAIN emite eventos por `postMessage`; a ponte encaminha ao background. Mensagens de runtime usam `{source: "pip-log-store", command}` com comandos `append`, `snapshot`, `clear`, `enabled`. O background valida os comandos e restringe alterações de configuração às páginas de configuração. Respostas são `{ok: true, snapshot?}` ou `{ok: false, error}`; append recebe apenas confirmação, para não retransmitir o histórico inteiro por evento.

O background é o único escritor. Agrupa no máximo 50 entradas ou 250 ms e serializa escritas. Limpeza e ativação forçam o lote anterior antes de entrar na fila. Eventos recebidos depois da limpeza permanecem. A chave `logMeta` registra revisão monotônica, recebidos, descartados e início disponível; a revisão impede que uma resposta atrasada substitua uma atualização mais nova da interface.

Retenção: os 5.000 registros mais recentes, limitados também a 4 MiB de JSON em UTF-8. Entradas antigas são descartadas primeiro. A leitura inicial não altera nem trunca o histórico. IDs repetidos no histórico disponível são deduplicados. Falhas de gravação não apagam os dados anteriores e são comunicadas à interface; eventos cujo lote falhou podem não ser persistidos. Não há reenvio automático que possa ressuscitar entradas anteriores a uma limpeza.

Nenhuma permissão, dependência ou polling adicional na página do player foi acrescentado. O estado do PiP e suas heurísticas de proteção não dependem dos metadados de diagnóstico.

## Validação

```bash
node --test scripts/test-logs.mjs
node scripts/test-firefox-pause.mjs
npx --no-install tsc --noEmit
npm run build
python scripts/test-firefox-ui.py
```

O teste Python usa somente a biblioteca padrão, Firefox instalado e um perfil temporário próprio, em modo headless. Aceita o caminho do executável como argumento. Não usa o perfil nem as abas existentes. Em ambientes com sandbox, a criação dos subprocessos do Firefox pode exigir execução fora dele.

Usa a automação Marionette, com acesso de sistema habilitado exclusivamente nesse processo de teste para navegar à página `moz-extension://`. Compatibilidade: argumento `--remote-allow-system-access` e variável de ambiente `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`. Não adicionar essas opções ao fluxo normal de uso.

Validado no Firefox 159.0.1 em 07/11/2026: extensão empacotada, runtime/storage reais com dados de teste, atualização ao vivo, pausa/retomada, ancoragem em lista paginada, filtros, detalhes, exportações, layout, falha inline, limpeza e ativação. Capturas de desktop/janela estreita ficam em `dist/log-timeline-*.png` e não são versionadas. Isso não comprova estabilidade do PiP durante reprodução real no YouTube Music.

Referências para evitar repetir a pesquisa: [protocolo Marionette](https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html), [introdução](https://firefox-source-docs.mozilla.org/remote/marionette/Intro.html), [mudança para a variável de acesso de sistema](https://bugzilla.mozilla.org/show_bug.cgi?id=2054887).
