# Passagem da pipeline - 2026-09-09

## Entrega verificada

Fase 1 implementada para landing pages estáticas: Nina transforma briefing em spec; Atlas produz plano validado de três tarefas; Juno gera somente HTML/CSS; Vera executa build e node:test confiáveis; Atlas cria commit local e faz push somente se um remoto explícito for recebido pela API interna do worker. O percurso tem cinco tarefas persistidas (ingest_briefing, plan_tasks, build_landing, qa_landing, publish_landing). Sem push, todas terminam done e projeto fica review. Shipped exige push confirmado.

As três chamadas de modelo aceitam injeção de PipelineRouter = Pick<ModelRouter, 'chat'>. QA e Git não fazem chamadas de IA. Não há chave, chamada paga, envio ao GitHub ou implantação nesta validação.

## Arquivos deste escopo

- apps/orchestrator/src/queue.ts: worker serial, execução manual, dependências, tentativa conferida, transições, quarentena, cancelamento e encerramento cooperativo.
- apps/orchestrator/src/agents/product-owner.ts, tech-lead.ts e builder.ts: agentes com resposta JSON, validação e AbortSignal.
- apps/orchestrator/src/pipeline/contracts.ts: contratos restritos do plano e conteúdo, limite de resposta e erro de segurança.
- apps/orchestrator/src/pipeline/workspace.ts: paths de projeto, allowlist HTML/CSS, CSP, scripts fixos, QA, commit e publicação opcional.
- apps/orchestrator/test/pipeline.test.ts: nove regressões offline executadas.

## APIs para integração

runNextTask(router, options?: { signal?: AbortSignal; publish?: { remote: string; branch?: string } }): Promise<boolean>. Retorna true quando retirou uma tarefa, inclusive se ela falhar; false quando não há tarefa pronta ou outra execução está ativa. startWorker(router, intervalMs=1500, options?) inicia um único loop e recupera tarefas interrompidas antes de operar. stopWorker(): Promise<void> cancela e aguarda a execução ativa. cancelProjectWork(projectId): void cancela o controller ativo; o chamador deve persistir aborted e abortProjectTasks quando se trata de cancelamento administrativo. Cancelamento sem estado terminal preexistente coloca o projeto em quarentena para inspeção.

O startup não deve chamar recoverInterruptedTasks simultaneamente com worker ativo. O servidor deve iniciar worker somente depois de escutar a porta e aguardar stopWorker no shutdown. Não há necessidade de novas mudanças em db para a pipeline.

## Evidência executada

Comando: npm run typecheck -w @jpxforge/orchestrator. Resultado: passou.

Comando: node --import tsx --test apps/orchestrator/test/pipeline.test.ts. Resultado: 9 testes passaram, zero falhas, aproximadamente 4,2 segundos. Todos usaram FORGE_DATA_DIR temporário, FakeRouter e nenhuma API externa. Diretório temporário removido ao final.

1. Briefing percorre cinco tarefas dependentes, roda build e node:test reais, gera commit local com seis arquivos permitidos e fica review.
2. Push real para repositório bare temporário confirma a branch joao2709/offline-test e o hash do commit; projeto fica shipped e tarefa done.
3. Falha de modelo repete somente duas vezes e bloqueia dependentes em quarentena.
4. HTML com script é rejeitado antes de gravar arquivo, sem retry pago.
5. Validador rejeita handlers, javascript obfuscado, âncora quebrada, comentários, iframe, CSS externo e funções não permitidas.
6. QA rejeita template executável adulterado antes de executar.
7. Paths de escape, credenciais no remoto, protocolos arbitrários e branches de produção são rejeitados.
8. Duas chamadas de fila não sobrepõem trabalho; resultado tardio não ressuscita projeto abortado.
9. stopWorker cancela o modelo, aguarda a tarefa e termina em quarentena consistente.

## Limitações e próximos passos

O template atual não aceita JavaScript, imagens, formulários, dependências externas, @media ou outros at-rules. Responsividade usa flex/grid/clamp. QA prova integridade da cópia, semântica mínima, CTA e ausência de conteúdo executável; não substitui revisão visual, acessibilidade completa nem aceite comercial. Tipos de serviço diferentes de landing_page vão para quarentena.

Somente HTTPS sem credenciais/query/fragmento ou caminho absoluto local é aceito para push. A branch precisa começar com joao2709/ ou forge/ e não pode ser main/master/prod/production. SSH ainda não foi implementado. O worker não faz force-push nem cria repositório remoto. A interface pública para configurar publicação e o piloto de autenticação Git devem ser verificados separadamente. Sem remoto, o resultado contém workspace, commit, branch e published=false.

A execução de comandos se limita a scripts versionados que são comparados antes de QA e Git; modelos nunca fornecem comandos ou arquivos executáveis. Há proteção contra paths externos, links e arquivos inesperados. Isso não é um sandbox para código arbitrário ou atacantes locais concorrentes: isolamento de processo/container, scanners, autenticação, orçamento e retomada humana da quarentena permanecem na fila da Fase 3. Um crash ou cancelamento durante push exige inspeção do remoto antes de retomar. O modelo real DeepSeek e sua taxa de aceitação pelo subset HTML/CSS ainda precisam ser medidos.

## Obrigação de continuidade

O próximo modelo deve ler AGENTS.md, docs/HANDOFF.md, docs/BACKLOG.md e este relatório; descrever o trabalho durante a execução; conferir Git e testes atuais; registrar alterações, limites e próxima tarefa na mesma fila. Ao atingir 90% de uso, priorizar o PDF. Antes de encerrar, atualizar os relatórios, gerar output/pdf/JPXFORGE-CONTINUIDADE.pdf com scripts/export_handoff.py, conferir a renderização e repetir expressamente esta obrigação para o modelo seguinte. O agente principal coordena o PDF consolidado desta passagem. Este subescopo não fez commit no repositório Forge.

## Atualização consolidada

Após este relatório, POST /projects/:id/publish e o botão de envio no painel real foram implementados. Quatro testes adicionais verificaram envio bare, duplicatas, pré-condições e bloqueio em demonstração. A suíte completa passou com 47 testes; checkpoint de código 82a90af. A limitação anterior de interface pública foi resolvida; autenticação GitHub real continua pendente.
