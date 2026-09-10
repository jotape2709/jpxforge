# Continuidade do JPXFORGE

Este projeto continua por uma fila única, mesmo quando muda o modelo de IA.

1. Leia `docs/HANDOFF.md`, `docs/BACKLOG.md` e os relatórios específicos em `docs/*-HANDOFF.md` antes de alterar o código. Confira o estado real do Git; o PDF é um retrato, o checkout pode ser mais recente.
2. Descreva ao João o que está fazendo e os resultados relevantes durante a execução. Não declare uma fase concluída sem evidência executada.
3. Trabalhe no primeiro item pendente da fila. Atualize a fila e os resultados antes de encerrar. Preserve trabalho anterior e não altere o contrato v1 do WORK sem solicitação explícita.
4. Ao atingir 90% de uso disponível, priorize imediatamente a atualização do documento de passagem e do PDF. Não espere o limite de 100%. Se não houver medidor, produza checkpoints antecipados.
5. Antes de terminar, atualize `docs/HANDOFF.md`, registre arquivos alterados, comandos executados, testes que passaram/falharam, limitações, branch/commit, próximos passos e gere `output/pdf/JPXFORGE-CONTINUIDADE.pdf` com `scripts/export_handoff.py` (Python + reportlab). Renderize e confira o PDF. Inclua novamente neste documento a obrigação de o próximo modelo repetir este protocolo.
6. Nunca inclua chaves, tokens, conteúdo de configuração secreta, banco real ou dados de clientes no PDF, Git, logs ou prompts. Testes devem usar diretórios temporários e provedores locais simulados, salvo validação real autorizada.
7. O WORK administra pedidos, clientes e aprovações. O Forge executa desenvolvimento e relata evidências. Não opere produção nem retire trabalho real automaticamente durante testes.

Comandos de verificação e estado da implantação estão no README e no HANDOFF. O PDF e a fila não substituem a inspeção do código.
