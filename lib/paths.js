// Percorsi e impostazioni di ambiente comuni a tutta l'app.
//
//  DATA_DIR        cartella dei dati (telecamere, database, eventi, modelli). Predefinita: ./data
//  GO2RTC_BIN      eseguibile di go2rtc. Predefinito: ./bin/go2rtc(.exe)
//  HOST / PORT     indirizzo e porta dell'interfaccia (predefiniti 127.0.0.1 e 8780)
//  TLS_CERT/TLS_KEY  certificato e chiave per servire in HTTPS
//  TRUST_PROXY=1   si fida di X-Forwarded-* (app dietro un reverse proxy)
//  WEBRTC_CANDIDATES  indirizzi con cui i client raggiungono la porta WebRTC, es. "192.168.1.50:8555"
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// I file creati dall'app (database con gli hash delle password, credenziali delle telecamere) sono leggibili solo dal suo utente.
process.umask(0o077);

export const ROOT =path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const GO2RTC_BIN = process.env.GO2RTC_BIN || path.join(ROOT, 'bin', process.platform === 'win32' ? 'go2rtc.exe' : 'go2rtc');
export const IS_WINDOWS = process.platform === 'win32';
