# Fila única de continuidade

Atualização: 2026-09-09. Trabalhar na ordem; descrever evidência ao marcar concluído.

1. VERIFICADO LOCALMENTE - Fundação: instalação Windows/Node 24, paths estáveis, schemas, fila serial, cancelamento, recuperação após crash, roteamento; 14 testes de fundação e 5 de API/WebSocket passaram.
2. VERIFICADO OFFLINE / ACEITE REAL PENDENTE - Pipeline seca chegou a cinco tarefas done e commit local com build + três testes da página; nove regressões de pipeline passaram, incluindo push bare local. Destino de envio por projeto oferecido pela API e painel real. Falta validar autenticação/entrega no GitHub com revisão.
3. PENDENTE - Validar DeepSeek real usando a chave do usuário pelo setup; registrar custo/tokens e resultado sem vazar segredos. Não há chave configurada no checkout inspecionado.
4. MVP VERIFICADO - Dashboard vivo: escritório isométrico, seis sprites, presença, tarefas, briefing, chat de eventos, prévia, reconexão e replay limitado. Pendentes: configurações visuais, chat livre, filtros e revisão de acessibilidade. Ver DASHBOARD-HANDOFF.
5. PENDENTE - Segurança/custos: isolamento de execução para futuros serviços com código arbitrário, scanners, retomada humana de quarentena, preço por modelo, orçamento e bloqueio de gastos. Não confundir contabilizar tokens com medir custo real.
6. PENDENTE - Piloto WORK contrato v1: fila vazia, claim, evento perdido, ACK repetido, 409 divergente, cancelamento, lease, ajuste/nova tentativa, revisão humana. Manter auto_claim desligado até evidência.
7. PENDENTE - Templates de site institucional, API, dashboard e automação com critérios de aceite próprios.
8. A CADA PASSAGEM - Atualizar HANDOFF, fila, testes e PDF; impor novamente o mesmo protocolo ao próximo modelo. Ao atingir 90% de uso, este item tem prioridade imediata.
