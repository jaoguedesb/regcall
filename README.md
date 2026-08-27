# RegCall

Plataforma de comunicação por **voz, texto e compartilhamento de tela** no estilo Discord.
Áudio e vídeo vão direto entre os navegadores (WebRTC P2P) — o servidor só faz a sinalização,
então ele é leve e roda de boa até no plano gratuito do Render/Railway.

---

## O que já funciona

| Recurso | Detalhe |
|---|---|
| Salas | Criar, entrar por código de 6 caracteres ou por link, listar salas ativas |
| Canais | Texto e voz, criados na hora; dono da sala pode apagar (clique direito no canal) |
| Voz | Entrar/sair, mutar, ensurdecer, indicador de quem está falando (anel verde) |
| Tela | 720p até 4K, 30/60fps, com áudio do sistema junto |
| Qualidade | Bitrate, framerate, codec (AV1/VP9/H.264/VP8) e prioridade nitidez × fluidez |
| Chat | Histórico do canal, links clicáveis, "fulano está digitando…", mensagens de sistema |
| Perfil | Trocar nick e cor do avatar a qualquer momento — propaga na hora |
| Dispositivos | Escolher microfone e saída de áudio, cancelamento de eco, supressão de ruído, ganho automático |
| Diagnóstico | Latência, upload/download, perda de pacotes, FPS, resolução e rota (direto/STUN/TURN) |
| Extras | Atalhos `Ctrl+M` (mudo) e `Ctrl+Shift+M` (ensurdecer), reconexão automática, layout mobile |

---

## Rodar na sua máquina

```bash
npm install
npm start
# abre http://localhost:3000
```

Para testar sozinho, abra duas abas (ou uma normal e uma anônima) e entre com nicks diferentes.

> **Importante:** o navegador só libera microfone e captura de tela em `https://` ou em `localhost`.
> Acessar por IP da rede local (`http://192.168.x.x`) **não** funciona sem HTTPS.

---

## Colocar no ar

### Render (mais simples)

1. Suba esta pasta para um repositório no GitHub.
2. No Render: **New → Web Service** → aponte pro repositório.
3. O `render.yaml` já configura tudo (build `npm install`, start `node server.js`, health check `/api/health`).
4. Em **Environment**, preencha as variáveis de TURN (veja abaixo).

### Railway

1. **New Project → Deploy from GitHub repo**.
2. O `railway.json` já define o start command e o health check.
3. Adicione as variáveis de ambiente em **Variables**.

### Docker (qualquer VPS)

```bash
docker build -t regcall .
docker run -d -p 3000:3000 --env-file .env --name regcall regcall
```

Coloque um Nginx/Caddy na frente com certificado HTTPS — sem HTTPS o navegador bloqueia o microfone.

---

## TURN — leia antes de chamar a galera

Sem TURN, cerca de 15–20% das conexões falham (redes corporativas, 4G/5G, CGNAT, Wi-Fi de trabalho).
Os dois lados até entram na sala e o chat funciona, mas o áudio e a tela não passam.

Jeito rápido e gratuito:

1. Crie conta em <https://www.metered.ca/tools/openrelay/> (tem tier grátis).
2. Copie usuário e credencial.
3. No painel do Render/Railway (ou no seu `.env`):

```env
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=seu_usuario
TURN_CREDENTIAL=sua_senha
```

Ao subir o servidor, o log mostra `TURN configurado: sim`. Dentro do app, em
**Configurações → Conexão**, a linha **Rota** mostra se aquela chamada está indo direto,
via STUN ou via TURN.

Prefere hospedar o seu? [coturn](https://github.com/coturn/coturn) faz o trabalho.

---

## Variáveis de ambiente

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do servidor (Render/Railway definem sozinhos) |
| `APP_NAME` | `RegCall` | Nome na aba do navegador |
| `TURN_URLS` | — | Lista de servidores TURN separada por vírgula |
| `TURN_USERNAME` | — | Usuário do TURN |
| `TURN_CREDENTIAL` | — | Senha do TURN |
| `STUN_URLS` | — | STUN extra (já vem com Google + Cloudflare) |
| `SERVER_PASSWORD` | — | Se preenchida, exige senha para entrar na plataforma |
| `SUPABASE_URL` | — | URL do projeto Supabase |
| `SUPABASE_SECRET_KEY` | — | Chave `sb_secret_...` usada somente pelo backend |
| `SUPABASE_STATE_ID` | `regcall-main` | Identificador desta instalação no banco |
| `ROOM_TTL_HOURS` | `0` | Horas para remover salas vazias; `0` mantém indefinidamente |

### Persistência das salas

O servidor salva automaticamente salas, canais e até 300 mensagens por canal no Supabase.
Execute primeiro [`supabase/schema.sql`](supabase/schema.sql) no SQL Editor e configure
`SUPABASE_URL` e `SUPABASE_SECRET_KEY` no ambiente do backend. A chave secreta nunca deve
ser enviada ao navegador. Presença e transmissões continuam efêmeras, pois só existem durante a conexão.

---

## Compartilhamento de tela não funciona?

O RegCall agora diz o motivo exato na tela. Os quatro casos comuns:

| Sintoma | Causa | Solução |
|---|---|---|
| "O navegador só libera captura de tela em HTTPS ou em localhost" | Você abriu por `http://192.168.x.x` ou por um domínio sem HTTPS | Use `http://localhost:3000` na mesma máquina, ou publique com HTTPS |
| "Entre em um canal de voz antes de compartilhar" | O botão só liga a transmissão dentro de um canal de voz | Clique em **Sala de Voz** na barra lateral primeiro |
| "Nenhuma tela disponível" / "O sistema não deixou capturar" | Permissão do sistema operacional | **macOS:** Ajustes → Privacidade e Segurança → Gravação de Tela → marque o navegador e **reinicie ele**. **Windows:** rode o navegador sem "modo jogo"/overlays de captura |
| Nada acontece ao clicar | Você fechou o seletor de tela | Normal — cancelar não é erro |

Se aparecer outra mensagem, abra o console do navegador (F12) e procure a linha
`[RegCall] falha ao compartilhar tela:` — ela traz o nome do erro e todas as tentativas
que o app fez antes de desistir.

---

## Logo

A identidade visual usa **`public/assets/spider-logo.png`** na tela de login, página inicial,
barra lateral, favicon e ícone para dispositivos Apple.

---

## Testes

Testes de verdade, com dois e três navegadores Chromium reais trocando mídia:

```bash
npm install playwright        # só na primeira vez
node test/e2e.mjs             # 30 verificações: login, sala, chat, voz, tela, mute, navegação
node test/mesh3.mjs           # 7 verificações: malha de 3 pessoas + renegociação simultânea
node test/share.mjs           # 11 verificações: getDisplayMedia real, entrada tardia, restart
node test/shots.mjs           # gera capturas de tela em shots/
npm run test:persistence      # confirma que salas sobrevivem ao reinício
```

Eles conferem, entre outras coisas, se os bytes de áudio e vídeo realmente trafegam entre os
peers e se as conexões continuam estáveis depois de duas pessoas compartilharem tela ao mesmo tempo.

---

## Como funciona por dentro

```
public/          front-end (sem framework, ES modules)
  js/rtc.js      motor WebRTC: negociação, mídia, bitrate, codec, estatísticas
  js/app.js      interface: salas, canais, chat, tiles de vídeo, configurações
  css/style.css  tema escuro
server.js        Express + Socket.IO: presença, salas, canais, chat, sinalização
```

**Malha P2P (mesh):** cada pessoa se conecta diretamente com todas as outras do canal de voz.
Isso dá a menor latência possível e custo zero de banda no servidor, e funciona muito bem até
**6–8 pessoas** por canal. Acima disso, o upload de quem compartilha tela começa a pesar
(cada participante recebe uma cópia própria do vídeo) — nesse ponto o caminho seria um SFU
tipo mediasoup ou LiveKit.

**Negociação:** usa o padrão *perfect negotiation* com papéis educado/não-educado, com
proteção extra contra colisão de ofertas — é o que faz duas pessoas começarem a compartilhar
tela no mesmo segundo sem derrubar a chamada.

**Estado:** salas e mensagens ficam em memória. Reiniciar o servidor limpa tudo, e salas
vazias somem depois de 1 hora. Para persistir (contas com senha, histórico permanente),
o próximo passo seria SQLite + `bcrypt`.

---

## Compatibilidade

| Navegador | Voz | Tela | Áudio do sistema |
|---|---|---|---|
| Chrome / Edge / Brave (desktop) | sim | sim | sim |
| Firefox (desktop) | sim | sim | não (limitação do Firefox) |
| Safari 16+ (macOS) | sim | sim | não |
| Chrome / Safari (celular) | sim | não recebe bem tela em 4K | — |

Compartilhar a tela **do celular** não é suportado por nenhum navegador móvel — é limitação
do sistema, não do RegCall.
