# Continuidade da integração WORK

Data: 2026-09-09. Checkout: `C:/Users/joaop/jpxforge`. Trabalho sem commit próprio; integrado à passagem principal do Codex.

## Estado e limite de ativação

A Fase 4 continua pendente. `auto_claim` permanece `false` por padrão. Configurar `auto_claim=true` gera erro explícito antes de iniciar o poller, porque ainda falta comprovar o ciclo completo de desenvolvimento e revisão com o WORK. O cliente HTTP possui `claim()` para futuro piloto, mas o poller atual não retira nenhum trabalho novo.

Com token e `auto_claim=false`, o poller drena eventos já persistidos de concessões existentes. O workerId deve continuar igual ao da concessão ativa; trocar esse identificador exige inspeção, sem buscar outro slot automaticamente. Nenhuma requisição foi feita ao WORK real durante esta passagem. O projeto original em `C:/Users/joaop/Documents/JPXWORK-CRM/work` foi apenas consultado, sem alterações.

## Contrato consultado

`work/docs/DEV-TEAM-CONTRACT.md`, `work/server/handoffs.mjs` e `work/server/index.mjs`. O ACK de evento é o objeto público do handoff diretamente; não contém claimToken. `progress` renova lease, enquanto `completed` passa a `awaiting_review` e `failed` a `failed`, ambos com lease nulo. HTTP 409 significa divergência e nunca confirma recebimento. Retransmissão válida mantém eventId, sequência e conteúdo.

## Alterações

- `apps/orchestrator/src/work-client.ts`: valida HTTPS ou loopback, impede credenciais/query/hash na URL, bloqueia redirects, aceita cancelamento, distingue revogação/conflito/erro de protocolo e valida ACK com schema runtime. Erros 4xx permanentes exigem inspeção; rede, 408, 429 e 5xx preservam evento para nova tentativa.
- `apps/orchestrator/src/executions.ts`: migração SQLite transacional da chave antiga para `(handoff_id, attempt)`, identificação da tentativa na outbox, corpo completo persistido, índices de concessão ativa por worker e handoff. Tentativa nova exige token novo e attempt maior. Alocação de sequência e inserção do evento acontecem na mesma transação. ACK, lease e encerramento terminal também são atômicos. Eventos posteriores a um terminal são recusados.
- `apps/orchestrator/src/work-poller.ts`: ciclos sem sobreposição, nenhuma retirada nova, reenvio ordenado que interrompe após primeira falha, confirmação somente quando ACK corresponde ao evento. Divergência ou revogação cancela trabalho cooperativamente e coloca o projeto em quarentena, preservando evento não confirmado. Lease é validado antes da rede e por timer separado durante a requisição. Shutdown cancela a requisição e aguarda seu encerramento.
- `apps/orchestrator/test/work.test.ts`: banco temporário isolado e servidor HTTP local simulado. Não usa token real, dados comerciais ou API de modelo.

## Evidência executada

Comando: `node --import tsx --test apps/orchestrator/test/work.test.ts`.

Resultado nesta passagem: **13 testes passaram, 0 falhas**. Incluem migração de registro legado com attempt 3; URL segura; fila vazia e workerId estável; metadados de aprovação; respostas 409/403 de claim; rollback quando insert da outbox falha; concessão única; nova tentativa; resposta perdida com mesmo corpo e ordem `[1,1,2]`; 409 sem confirmação; revogação com cancelamento; lease expirado antes e durante rede; ACK terminal; ACK divergente; ticks concorrentes; shutdown; bloqueio de auto_claim e drenagem com auto_claim desligado. Tipagem/build e suíte consolidada são registrados no documento principal após execução pelo responsável da passagem.

## Próximos passos da fila

1. Manter a integração em drenagem/status até concluir as fases anteriores e preparar um piloto isolado. Não confundir os testes mock com um piloto real aprovado.
2. No piloto, ligar os eventos ao ciclo real de pipeline e ao heartbeat de progresso, com evidência verificável de build/test/artefatos. Implementar persistência atômica do handoff, projeto e primeira tarefa antes de iniciar o trabalho. Validar revisão administrativa e ajustes com token novo, clientApproval e versão do briefing preservados.
3. Testar contra uma instância de WORK e banco descartáveis: claims concorrentes, resposta de claim perdida, resposta de evento perdida, repetição idêntica, divergência, cancelamento, lease e nova tentativa. Perda da resposta de claim exige inspeção no WORK; nunca trocar workerId para contornar ocupação.
4. Criar fluxo humano de inspeção da quarentena/outbox e retomada controlada. Eventos de concessões encerradas permanecem no banco como evidência e não são reenviados automaticamente. Corrupção ou duplicatas que violem os novos índices impedem a migração e exigem inspeção do banco, sem descarte automático.
5. Dados produzidos pelo adapter antigo podem conter falsos ACKs de 409. A migração preserva esses registros e não consegue provar retroativamente o recebimento. Inspecione o WORK antes de confiar em execuções antigas afetadas.

## Regra obrigatória de continuidade

O próximo modelo deve ler `AGENTS.md`, `docs/HANDOFF.md`, a fila em `docs/BACKLOG.md` e este relatório, conferir o Git real e descrever ao João o que está fazendo. Ao atingir 90% de uso deve priorizar imediatamente a passagem. Antes de encerrar, atualizar o que fez, testes, limitações e próximos passos, gerar novamente `output/pdf/JPXFORGE-CONTINUIDADE.pdf`, conferir sua renderização e repetir explicitamente esta mesma obrigação para o próximo modelo. Nunca incluir tokens, chaves, banco real ou dados de clientes no PDF.
