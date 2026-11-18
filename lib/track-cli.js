// Calcola i riquadri di un filmato in un processo a parte (il modello di riconoscimento blocca il processo per ~2 s a
// fotogramma: dentro il server renderebbe l'interfaccia lenta). Uso: node lib/track-cli.js <idEvento>
import * as recognition from './recognition.js';

try {
  await recognition.trackEvent(Number(process.argv[2]));
} catch (err) {
  console.error(`[riquadri] ${err.message}`);
  process.exitCode = 1;
}
process.exit();
