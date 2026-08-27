/**
 * RegCall — motor WebRTC (malha peer-to-peer)
 * ------------------------------------------------------------------
 * - Negociacao "perfeita" (perfect negotiation) para evitar colisao de ofertas
 * - Compartilhamento de tela com o audio da transmissao
 * - Controle fino de bitrate, framerate, codec e degradacao
 * - Controle de qualidade e estatisticas de conexao
 */

export const QUALITY_PRESETS = {
  '720p30':  { label: '720p 30fps',  w: 1280, h: 720,  fps: 30, bitrate: 2_500_000, note: 'Leve — internet fraquinha' },
  '720p60':  { label: '720p 60fps',  w: 1280, h: 720,  fps: 60, bitrate: 3_500_000, note: 'Fluido pra jogos' },
  '1080p30': { label: '1080p 30fps', w: 1920, h: 1080, fps: 30, bitrate: 4_500_000, note: 'Nítido pra texto e código' },
  '1080p60': { label: '1080p 60fps', w: 1920, h: 1080, fps: 60, bitrate: 8_000_000, note: 'O padrão do RegCall' },
  '1440p60': { label: '1440p 60fps', w: 2560, h: 1440, fps: 60, bitrate: 14_000_000, note: 'Precisa de banda boa' },
  '4k30':    { label: '4K 30fps',    w: 3840, h: 2160, fps: 30, bitrate: 20_000_000, note: 'Monitor grande, rede ótima' },
  'source':  { label: 'Original',    w: 0,    h: 0,    fps: 60, bitrate: 25_000_000, note: 'Resolução nativa da tela' },
};

const CODEC_ORDER = {
  auto: ['AV1', 'VP9', 'H264', 'VP8'],
  AV1: ['AV1', 'VP9', 'H264', 'VP8'],
  VP9: ['VP9', 'AV1', 'H264', 'VP8'],
  H264: ['H264', 'VP9', 'VP8', 'AV1'],
  VP8: ['VP8', 'H264', 'VP9', 'AV1'],
};

const noop = () => {};

export class RTCEngine {
  /**
   * @param {object} opts
   * @param {import('socket.io-client').Socket} opts.socket
   * @param {RTCIceServer[]} opts.iceServers
   * @param {object} opts.handlers
   */
  constructor({ socket, iceServers, handlers = {} }) {
    this.socket = socket;
    this.iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];

    this.on = {
      streams: noop,        // () => void   — algo mudou nas midias remotas
      peerState: noop,      // (peerId, state)
      stats: noop,          // (summary)
      screenEnded: noop,    // () => void   — usuario parou pela barra do navegador
      ...handlers,
    };

    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    /** @type {Map<string, {streams: Map<string, MediaStream>, kinds: Object}>} */
    this.remote = new Map();

    this.screenStream = null;
    this.lastScreenError = null;

    this.settings = {
      quality: '1080p60',
      contentHint: 'detail',
      codec: 'auto',
      systemAudio: true,
    };

    this._bindSocket();
    this._statsTimer = null;
    this._lastStats = new Map();
  }

  /* ================= socket ================= */

  _bindSocket() {
    this.socket.on('rtc:peer-joined', ({ peerId, polite }) => {
      this.addPeer(peerId, polite === true);
    });
    this.socket.on('rtc:peer-left', ({ peerId }) => this.removePeer(peerId));
    this.socket.on('rtc:signal', (msg) => this._onSignal(msg));
    this.socket.on('rtc:tracks', ({ from, map }) => {
      const entry = this._remoteEntry(from);
      entry.kinds = map || {};
      this.on.streams();
    });
  }

  /* ================= tela ================= */

  /**
   * Descobre por que a captura de tela nao esta disponivel, se for o caso.
   * @returns {null | { reason: string, message: string }}
   */
  static screenSupport() {
    if (typeof window === 'undefined') return { reason: 'no-window', message: 'Ambiente sem navegador.' };
    if (!window.isSecureContext) {
      return {
        reason: 'insecure-context',
        message: 'O navegador só libera captura de tela em HTTPS ou em localhost. '
          + `Você está em "${location.origin}". Acesse por http://localhost:PORTA ou publique com HTTPS.`,
      };
    }
    if (!navigator.mediaDevices) {
      return { reason: 'no-mediadevices', message: 'Este navegador não expõe navigator.mediaDevices (contexto inseguro ou navegador antigo).' };
    }
    if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      return {
        reason: 'unsupported',
        message: 'Este navegador não suporta captura de tela. Navegadores de celular (Android/iOS) não permitem isso — use um computador.',
      };
    }
    return null;
  }

  /** Usa opcoes amplamente aceitas no pedido inicial de captura. */
  _screenAttempts() {
    const wantAudio = this.settings.systemAudio;
    return [{ label: 'compativel', c: { video: true, audio: wantAudio } }];
  }

  async startScreen() {
    const unsupported = RTCEngine.screenSupport();
    if (unsupported) {
      const err = new Error(unsupported.message);
      err.name = 'RegCallUnsupported';
      err.reason = unsupported.reason;
      throw err;
    }

    let stream = null;
    let primaryError = null;
    const tried = [];

    // Erros em que o seletor de tela JA apareceu. Insistir e inutil: o Chrome
    // consome a "ativacao transitoria" do clique, e a 2a tentativa viraria um
    // NotAllowedError falso que esconderia a causa real.
    const FINAL = ['NotAllowedError', 'AbortError', 'NotReadableError', 'NotFoundError', 'RegCallUnsupported'];

    for (const attempt of this._screenAttempts()) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(attempt.c);
        if (attempt.label !== 'completo') {
          console.warn(`[RegCall] captura de tela caiu para o modo "${attempt.label}"`, tried);
        }
        break;
      } catch (err) {
        tried.push(`${attempt.label} → ${err.name}: ${err.message}`);
        if (!primaryError) primaryError = err;
        if (FINAL.includes(err.name)) break;
      }
    }

    if (!stream) {
      const err = primaryError || new Error('Falha desconhecida na captura de tela.');
      err.attempts = tried;
      this.lastScreenError = {
        name: err.name, message: err.message, attempts: tried, at: new Date().toISOString(),
      };
      throw err;
    }
    this.lastScreenError = null;
    this.screenStream = stream;

    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.contentHint = this.settings.contentHint;
      vTrack.addEventListener('ended', () => {
        if (this.screenStream === stream) {
          this.stopScreen();
          this.on.screenEnded();
        }
      });
    }
    for (const a of stream.getAudioTracks()) a.contentHint = 'music';

    // Aplica qualidade depois da escolha. Restricoes no pedido inicial fazem
    // alguns navegadores recusarem a captura antes de abrir o seletor.
    const preset = QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS['1080p60'];
    if (vTrack && preset.w) {
      try {
        await vTrack.applyConstraints({
          width: { ideal: preset.w },
          height: { ideal: preset.h },
          frameRate: { ideal: preset.fps },
        });
      } catch (e) {
        console.warn('[RegCall] usando a qualidade nativa da tela', e);
      }
    }

    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) {
        try { peer.pc.addTrack(track, stream); } catch (e) { console.warn('addTrack screen', e); }
      }
      this._tuneVideoSenders(peer);
    }
    this._publishTrackMap();
    return stream;
  }

  stopScreen() {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;
    const ids = new Set(stream.getTracks().map((t) => t.id));

    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && ids.has(sender.track.id)) {
          try { peer.pc.removeTrack(sender); } catch (e) { console.warn('removeTrack', e); }
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
    this._publishTrackMap();
  }

  get isSharing() { return Boolean(this.screenStream); }

  /** Coleta tudo que importa pra descobrir por que a captura de tela falhou. */
  async diagnostics() {
    const md = navigator.mediaDevices;
    const out = {
      endereco: location.origin,
      contextoSeguro: window.isSecureContext,
      mediaDevices: Boolean(md),
      getDisplayMedia: typeof md?.getDisplayMedia === 'function',
      dentroDeIframe: window.top !== window.self,
      paginaVisivel: document.visibilityState,
      peersConectados: this.peers.size,
      transmitindo: this.isSharing,
      qualidade: this.settings.quality,
      codec: this.settings.codec,
      audioDoSistema: this.settings.systemAudio,
      navegador: navigator.userAgent,
      plataforma: navigator.userAgentData?.platform || navigator.platform || '—',
      codecsDeVideo: '—',
      ultimoErroDeTela: this.lastScreenError || 'nenhum',
    };
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      out.codecsDeVideo = [...new Set(caps.codecs.map((c) => c.mimeType.split('/')[1]))].join(', ');
    } catch (e) { /* ignore */ }
    return out;
  }

  /** Aplica bitrate/fps/degradacao ao vivo (sem reiniciar a transmissao). */
  async applyQualityLive() {
    const preset = QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS['1080p60'];
    const track = this.screenStream?.getVideoTracks()[0];
    if (track) {
      track.contentHint = this.settings.contentHint;
      if (preset.w) {
        try {
          await track.applyConstraints({
            width: { ideal: preset.w, max: preset.w },
            height: { ideal: preset.h, max: preset.h },
            frameRate: { ideal: preset.fps, max: preset.fps },
          });
        } catch (e) { console.warn('applyConstraints', e); }
      }
    }
    for (const peer of this.peers.values()) await this._tuneVideoSenders(peer);
  }

  async _tuneVideoSenders(peer) {
    const preset = QUALITY_PRESETS[this.settings.quality] || QUALITY_PRESETS['1080p60'];
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = preset.bitrate;
        params.encodings[0].maxFramerate = preset.fps;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
        params.degradationPreference =
          this.settings.contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
        await sender.setParameters(params);
      } catch (e) { console.warn('setParameters', e); }
    }
    // preferencia de codec
    this._applyCodecPreferences(peer);
  }

  _applyCodecPreferences(peer) {
    if (typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities) return;
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    const order = CODEC_ORDER[this.settings.codec] || CODEC_ORDER.auto;

    const score = (c) => {
      const name = (c.mimeType.split('/')[1] || '').toUpperCase();
      const i = order.indexOf(name);
      return i === -1 ? order.length + 1 : i;
    };
    const sorted = [...caps.codecs].sort((a, b) => score(a) - score(b));

    for (const tr of peer.pc.getTransceivers()) {
      const kind = tr.sender?.track?.kind || tr.receiver?.track?.kind;
      if (kind !== 'video') continue;
      if (typeof tr.setCodecPreferences !== 'function') continue;
      try { tr.setCodecPreferences(sorted); } catch (e) { /* codec nao suportado */ }
    }
  }

  /* ================= peers ================= */

  _remoteEntry(peerId) {
    if (!this.remote.has(peerId)) this.remote.set(peerId, { streams: new Map(), kinds: {} });
    return this.remote.get(peerId);
  }

  addPeer(peerId, polite) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });

    const peer = {
      id: peerId,
      pc,
      polite: Boolean(polite),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      needsNegotiation: false,
      pendingCandidates: [],
      restartTimer: null,
    };
    this.peers.set(peerId, peer);
    this._remoteEntry(peerId);

    pc.onnegotiationneeded = () => this._negotiate(peer);

    pc.onsignalingstatechange = () => {
      // Se uma renegociacao ficou pendente por causa de colisao, refaz assim que estabilizar.
      if (pc.signalingState === 'stable' && peer.needsNegotiation && !peer.makingOffer) {
        peer.needsNegotiation = false;
        setTimeout(() => this._negotiate(peer), 0);
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('rtc:signal', { to: peerId, candidate: candidate.toJSON() });
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      const entry = this._remoteEntry(peerId);
      if (!entry.streams.has(stream.id)) {
        entry.streams.set(stream.id, stream);
        stream.addEventListener('removetrack', () => {
          if (stream.getTracks().length === 0) {
            entry.streams.delete(stream.id);
            this.on.streams();
          }
        });
      }
      ev.track.addEventListener('ended', () => this.on.streams());
      ev.track.addEventListener('mute', () => this.on.streams());
      ev.track.addEventListener('unmute', () => this.on.streams());
      this.on.streams();
    };

    pc.onconnectionstatechange = () => {
      this.on.peerState(peerId, pc.connectionState);
      if (pc.connectionState === 'connected') this.resumeAudio();
      if (pc.connectionState === 'failed') this._restartIce(peer);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected') {
        clearTimeout(peer.restartTimer);
        peer.restartTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') this._restartIce(peer);
        }, 3000);
      }
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        clearTimeout(peer.restartTimer);
      }
    };

    // publica as midias locais
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) {
        try { pc.addTrack(t, this.screenStream); } catch (e) { console.warn(e); }
      }
    }
    this._tuneVideoSenders(peer);

    // manda o mapa de streams pra esse peer especifico
    this.socket.emit('rtc:tracks', { to: peerId, map: this._localTrackMap() });
    return peer;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      clearTimeout(peer.restartTimer);
      try { peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.close(); } catch (e) { /* ignore */ }
      this.peers.delete(peerId);
    }
    this.remote.delete(peerId);
    this._lastStats.delete(peerId);
    this.on.streams();
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.peers.clear();
    this.remote.clear();
  }

  async _restartIce(peer) {
    try {
      if (typeof peer.pc.restartIce === 'function') {
        peer.pc.restartIce();
      } else {
        const offer = await peer.pc.createOffer({ iceRestart: true });
        await peer.pc.setLocalDescription(offer);
        this.socket.emit('rtc:signal', { to: peer.id, description: peer.pc.localDescription });
      }
    } catch (e) { console.warn('restartIce', e); }
  }

  /* ================= sinalizacao ================= */

  /** Cria e envia uma oferta, protegido contra colisao (glare). */
  async _negotiate(peer) {
    const pc = peer.pc;
    if (peer.makingOffer) { peer.needsNegotiation = true; return; }
    if (pc.signalingState !== 'stable') { peer.needsNegotiation = true; return; }
    try {
      peer.makingOffer = true;
      await this._setLocal(pc, 'offer');
      this.socket.emit('rtc:signal', { to: peer.id, description: pc.localDescription });
    } catch (e) {
      // se o estado mudou no meio do caminho, tenta de novo quando estabilizar
      peer.needsNegotiation = true;
      if (e.name !== 'InvalidStateError') console.warn('negotiate', e);
    } finally {
      peer.makingOffer = false;
    }
  }

  async _setLocal(pc, want) {
    const type = want || (pc.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
    const desc = type === 'answer' ? await pc.createAnswer() : await pc.createOffer();
    // O estado pode ter mudado enquanto o SDP era gerado (async).
    const expected = type === 'answer' ? 'have-remote-offer' : 'stable';
    if (pc.signalingState !== expected) {
      const err = new Error(`signalingState mudou para ${pc.signalingState}`);
      err.name = 'InvalidStateError';
      throw err;
    }
    if (desc.sdp) {
      desc.sdp = mungeOpus(desc.sdp, {
        stereo: true,
        bitrate: 128000,
        dtx: false,
      });
    }
    await pc.setLocalDescription(desc);
  }

  async _onSignal({ from, description, candidate }) {
    const peer = this.peers.get(from);
    if (!peer) return;
    const pc = peer.pc;

    try {
      if (description) {
        const readyForOffer =
          !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
        const offerCollision = description.type === 'offer' && !readyForOffer;

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        // Peer educado cede: sua propria oferta e descartada (rollback implicito),
        // entao marca que precisa reofertar depois pra nao perder tracks novas.
        if (offerCollision && peer.polite) peer.needsNegotiation = true;

        peer.settingRemoteAnswer = description.type === 'answer';
        await pc.setRemoteDescription(description);
        peer.settingRemoteAnswer = false;

        // candidatos que chegaram antes da descricao remota
        for (const c of peer.pendingCandidates.splice(0)) {
          try { await pc.addIceCandidate(c); } catch (e) { /* ignore */ }
        }

        if (description.type === 'offer') {
          await this._setLocal(pc, 'answer');
          this.socket.emit('rtc:signal', { to: from, description: pc.localDescription });
        }
      } else if (candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          peer.pendingCandidates.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          if (!peer.ignoreOffer) console.warn('addIceCandidate', e);
        }
      }
    } catch (e) {
      console.error('signal error', e);
    }
  }

  /* ================= mapa de streams ================= */

  _localTrackMap() {
    const map = {};
    if (this.screenStream) map[this.screenStream.id] = 'screen';
    return map;
  }

  _publishTrackMap() {
    if (!this.peers.size) return;
    this.socket.emit('rtc:tracks', { map: this._localTrackMap() });
  }

  /** Retorna somente a transmissao de tela de um peer. */
  mediaOf(peerId) {
    const entry = this.remote.get(peerId);
    const out = { screen: null };
    if (!entry) return out;
    for (const [id, stream] of entry.streams) {
      const kind = entry.kinds[id];
      if (kind === 'screen') out.screen = stream;
      else if (!kind) {
        // Uma faixa de audio isolada nao faz parte do modo live.
        if (stream.getVideoTracks().length) out.screen = out.screen || stream;
      }
    }
    if (out.screen && out.screen.getVideoTracks().every((t) => t.readyState === 'ended')) out.screen = null;
    return out;
  }

  async resumeAudio() {
    const plays = [...document.querySelectorAll('video[data-rc-media]')]
      .map((el) => el.play().catch(() => {}));
    await Promise.allSettled(plays);
  }

  /* ================= estatisticas ================= */

  startStats(intervalMs = 2000) {
    this.stopStats();
    this._statsTimer = setInterval(() => this._collectStats(), intervalMs);
  }

  stopStats() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
  }

  async _collectStats() {
    if (!this.peers.size) { this.on.stats(null); return; }
    let rttSum = 0, rttCount = 0;
    let outBits = 0, inBits = 0;
    let lossPct = 0, lossCount = 0;
    let fps = 0, width = 0, height = 0;
    let transport = '—';

    for (const [id, peer] of this.peers) {
      let report;
      try { report = await peer.pc.getStats(); } catch (e) { continue; }
      const prev = this._lastStats.get(id) || {};
      const now = {};

      report.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated !== false) {
          if (typeof s.currentRoundTripTime === 'number') { rttSum += s.currentRoundTripTime * 1000; rttCount++; }
        }
        if (s.type === 'outbound-rtp' && !s.isRemote) {
          now[`out-${s.id}`] = { bytes: s.bytesSent || 0, ts: s.timestamp };
          const p = prev[`out-${s.id}`];
          if (p && s.timestamp > p.ts) {
            outBits += ((s.bytesSent - p.bytes) * 8) / ((s.timestamp - p.ts) / 1000);
          }
          if (s.kind === 'video') {
            if (s.framesPerSecond) fps = Math.max(fps, Math.round(s.framesPerSecond));
            if (s.frameWidth) { width = Math.max(width, s.frameWidth); height = Math.max(height, s.frameHeight); }
          }
        }
        if (s.type === 'inbound-rtp' && !s.isRemote) {
          now[`in-${s.id}`] = { bytes: s.bytesReceived || 0, ts: s.timestamp };
          const p = prev[`in-${s.id}`];
          if (p && s.timestamp > p.ts) {
            inBits += ((s.bytesReceived - p.bytes) * 8) / ((s.timestamp - p.ts) / 1000);
          }
          const total = (s.packetsReceived || 0) + (s.packetsLost || 0);
          if (total > 0) { lossPct += ((s.packetsLost || 0) / total) * 100; lossCount++; }
          if (s.kind === 'video' && s.framesPerSecond) fps = Math.max(fps, Math.round(s.framesPerSecond));
          if (s.kind === 'video' && s.frameWidth) { width = Math.max(width, s.frameWidth); height = Math.max(height, s.frameHeight); }
        }
        if (s.type === 'local-candidate' && s.candidateType) {
          if (s.candidateType === 'relay') transport = 'TURN (relay)';
          else if (transport === '—') transport = s.candidateType === 'host' ? 'Direto (LAN)' : 'P2P (STUN)';
        }
      });
      this._lastStats.set(id, now);
    }

    this.on.stats({
      peers: this.peers.size,
      rtt: rttCount ? Math.round(rttSum / rttCount) : null,
      up: outBits,
      down: inBits,
      loss: lossCount ? lossPct / lossCount : 0,
      fps,
      resolution: width ? `${width}x${height}` : '—',
      transport,
    });
  }
}

/* ================= util ================= */

/** Ajusta o fmtp do Opus para estereo + bitrate alto. */
function mungeOpus(sdp, { stereo, bitrate, dtx = false }) {
  try {
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(eol);
    const rtpmapIdx = lines.findIndex((l) => /^a=rtpmap:\d+\s+opus\/48000\/2/i.test(l));
    if (rtpmapIdx === -1) return sdp;
    const pt = lines[rtpmapIdx].match(/^a=rtpmap:(\d+)/)[1];
    const params = [
      'minptime=10',
      'useinbandfec=1',
      `usedtx=${dtx ? 1 : 0}`,
      `stereo=${stereo ? 1 : 0}`,
      `sprop-stereo=${stereo ? 1 : 0}`,
      `maxaveragebitrate=${bitrate}`,
      'maxplaybackrate=48000',
    ].join(';');
    const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (fmtpIdx !== -1) lines[fmtpIdx] = `a=fmtp:${pt} ${params}`;
    else lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${pt} ${params}`);
    return lines.join(eol);
  } catch (e) {
    return sdp;
  }
}

export function formatBits(bps) {
  if (!bps || bps < 1) return '0 kbps';
  if (bps < 1_000_000) return `${Math.round(bps / 1000)} kbps`;
  return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}
