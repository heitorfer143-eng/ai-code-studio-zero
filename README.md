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
Railway deploy target: V15.5
