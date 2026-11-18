// Player: WebRTC con ripiego MSE, senza server STUN esterni (solo rete locale).
// Il codice del player è servito da go2rtc: se il motore video sta ancora partendo si riprova.
import { state, pref } from './state.js';
import { t } from './i18n.js';

async function loadPlayer() {
  for (let i = 0; ; i++) {
    try {
      return await import(`/go2rtc/video-rtc.js?try=${i}`);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
const { VideoRTC } = await loadPlayer();

/** Invia l'audio all'altoparlante scelto nelle impostazioni (dove il browser lo permette). */
export function applySink(video) {
  const id = pref.get('speaker');
  if (id && video.setSinkId) video.setSinkId(id).catch(() => {});
}

class CamStream extends VideoRTC {
  constructor() {
    super();
    this.pcConfig = { bundlePolicy: 'max-bundle', iceServers: [] };
  }

  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = true;
    const tile = () => this.closest('.tile');
    this.video.addEventListener('playing', () => {
      const tl = tile();
      tl?.classList.add('live');
      // L'audio è attivo solo per la telecamera selezionata (e non silenziata a mano).
      if (tl) this.video.muted = tl.dataset.id !== state.selectedId || tl.dataset.muted === '1';
      applySink(this.video);
    });
    for (const ev of ['emptied', 'stalled', 'ended']) {
      this.video.addEventListener(ev, () => tile()?.classList.remove('live'));
    }
  }

  setMode(text) {
    const el = this.closest('.tile')?.querySelector('.mode');
    if (el) el.textContent = text;
  }

  onopen() {
    const result = super.onopen();
    this.onmessage['camapp'] = (msg) => {
      if (msg.type === 'error') {
        this.setMode(t('tile.error'));
        // Accesso rifiutato: niente nuovi tentativi automatici, altrimenti la
        // telecamera (o l'NVR) blocca l'account anche per gli altri canali.
        const tile = this.closest('.tile');
        if (tile && /user\/pass|401|unauthorized/i.test(String(msg.value))) {
          tile.dataset.authFailed = '1';
          tile.querySelector('.wait').textContent = t('tile.authFailed');
        }
      } else if (['mse', 'hls', 'mp4', 'mjpeg'].includes(msg.type)) this.setMode(msg.type.toUpperCase());
    };
    return result;
  }

  onpcvideo(arg) {
    super.onpcvideo(arg);
    if (this.pcState !== WebSocket.CLOSED) this.setMode('WebRTC');
  }

  ondisconnect() {
    super.ondisconnect();
    this.closest('.tile')?.classList.remove('live');
  }
}
customElements.define('cam-stream', CamStream);

/**
 * Flusso con microfono (popup del campanello): invia la voce alla telecamera.
 * Come il player originale ma con il microfono scelto nelle impostazioni, e con il microfono
 * muto finché non si preme "Parla" (setTalking).
 */
class TalkStream extends VideoRTC {
  constructor() {
    super();
    this.pcConfig = { bundlePolicy: 'max-bundle', iceServers: [] };
    this.media = 'video,audio,microphone';
    this.micTracks = [];
  }

  oninit() {
    super.oninit();
    this.video.controls = false;
    this.video.muted = false;
    this.video.addEventListener('playing', () => applySink(this.video));
    this.video.addEventListener('volumechange', () => this.dispatchEvent(new CustomEvent('volumechange')));
  }

  async createOffer(pc) {
    try {
      const id = pref.get('mic');
      const media = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
      this.micTracks = media.getTracks();
      this.micTracks.forEach((track) => {
        track.enabled = false; // silenzioso finché non si parla
        pc.addTransceiver(track, { direction: 'sendonly' });
      });
    } catch (err) {
      this.dispatchEvent(new CustomEvent('micerror', { detail: err }));
    }
    for (const kind of ['video', 'audio']) pc.addTransceiver(kind, { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  setTalking(on) {
    for (const track of this.micTracks) track.enabled = !!on;
  }

  ondisconnect() {
    super.ondisconnect();
    for (const track of this.micTracks) track.stop(); // spegne l'indicatore del microfono
    this.micTracks = [];
  }
}
customElements.define('talk-stream', TalkStream);

export { CamStream, TalkStream };
