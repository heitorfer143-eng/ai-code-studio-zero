# AI Code Studio Zero

Projeto independente do Dreads Craft.

## Objetivo
IDE de programação mobile-first com chat, editor multi-arquivo e preview seguro no navegador, sem API paga.

## Segurança
O preview usa `iframe sandbox="allow-scripts"` e CSP com rede bloqueada (`connect-src 'none'`). O conteúdo gerado não é inserido na interface do chat via `innerHTML`.

## Custo
A versão atual não chama APIs de IA e não baixa modelos grandes automaticamente. O agente local inicial usa regras leves e será substituível por modelos locais/opcionais.

## Rodar
Abra `index.html` por um servidor estático. Os projetos são persistidos no `localStorage` do navegador.

## Estado
MVP: chat com streaming visual, editor multi-arquivo, HTML/CSS/JS, preview sandbox, console e persistência local.\n## Fallback de chat local (V15.5)\nQuando os gateways gratuitos retornam erro, o navegador tenta carregar um LLM local via WebGPU. O modelo fica no cache do navegador depois do primeiro download. Se WebGPU/modelo não estiver disponível, entra um fallback offline mínimo para o chat não cair em 503. Nenhuma API paga é usada automaticamente.\n
Railway deploy target: V15.8

## Conversas longas (V15.6)
O chat mantém o histórico completo na interface. Para a IA, o contexto recente agora é selecionado por orçamento de tamanho em vez de cortar cegamente em 6–8 mensagens: até 32 mensagens / ~18 mil caracteres nos provedores de nuvem e um orçamento menor no modelo local para respeitar a memória do dispositivo.

## Segurança V15.7

A V15.7 endurece a aplicação sem remover os recursos existentes:

- CSP, HSTS, `nosniff`, `frame-ancestors 'none'` e políticas de navegador.
- Arquivos estáticos públicos usam allowlist; `server.js`, arquivos de configuração e demais arquivos internos não são servidos diretamente.
- CORS aberto foi removido; operações web ficam restritas à mesma origem.
- Rate limiting para chat, login e cadastro.
- Erros enviados ao frontend passam por redaction para não expor tokens, chaves, URLs sensíveis ou variáveis de ambiente.
- Conteúdo de projeto, anexos, memória e pesquisa web é marcado como não confiável para reduzir prompt injection.
- Caminhos de arquivos são normalizados e rejeitam traversal, caminhos absolutos e nomes perigosos como `__proto__`.
- Arquivos como `.env`, chaves privadas e credenciais são omitidos do contexto da IA e do import remoto do GitHub.
- Uploads têm limites de tamanho/quantidade e imagens/PDFs passam por verificação de assinatura.
- Ações destrutivas/de infraestrutura continuam exigindo confirmação do usuário.
- Dependências de runtime são fixadas em versões específicas; o importador ZIP usa a cópia local de `@zip.js/zip.js`.

Limitação conhecida: a sandbox de execução ainda não é um isolamento de sistema operacional completo. Execução de código não confiável deve continuar sendo tratada como recurso de alta confiança até a fase de sandbox dedicada.

- O importador ZIP usa `@zip.js/zip.js` localmente e valida quantidade de entradas, CRC, caminhos e tamanho descompactado para reduzir risco de ZIP bomb.

## Contexto inteligente V15.8

A V15.8 reduz perda de contexto sem simplesmente aumentar o prompt:

- Novo `context-engine.js`, separado do arquivo principal.
- Índice incremental por hash: arquivos que não mudaram reutilizam análise em cache.
- Mapa de linguagens, tamanho, funções/classes/sinais/nós, imports e referências.
- Recuperação por relevância: o pedido seleciona automaticamente os arquivos mais relacionados e também dependências próximas.
- Tarefas amplas de arquitetura/refatoração usam uma janela maior de arquivos.
- O índice global mantém visão da estrutura mesmo quando somente alguns arquivos entram com conteúdo completo.
- Validação de `res://` e referências considera também os arquivos presentes somente no índice global.
- Conversas longas mantêm até 24 mensagens recentes + resumo automático compacto das mensagens antigas.
- Blocos grandes de código de respostas antigas são compactados, porque o estado atual já está disponível no projeto.
- O fallback WebGPU local também recebe o resumo compacto.
- Arquivos sensíveis continuam excluídos do índice/contexto; a conversão automática para Godot também aplica essa proteção.
- O status mostra quantos arquivos foram recuperados para a tarefa atual.

O índice é calculado no navegador e não depende de API paga.
