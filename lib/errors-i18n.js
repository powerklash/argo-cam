// Traduzione dei messaggi d'errore del server (le risposte delle API e gli stati mostrati nell'interfaccia).
//
// Nel codice i messaggi sono scritti in italiano. Prima di uscire verso il browser, `localize(testo, lingua)` li
// cerca in questa tabella e restituisce la versione nella lingua dell'interfaccia (it, en, fr, de, es); un messaggio
// senza voce resta com'è. Le parti variabili dei messaggi si indicano con {1}, {2}… (stesso ordine in ogni lingua).
// `node tools/check-errors.mjs` elenca i messaggi del codice che mancano qui.
//
// Ogni riga: [italiano, inglese, francese, tedesco, spagnolo]
const ROWS = [
  // --- richieste e accesso ---
  ['Richiesta troppo grande', 'Request too large', 'Requête trop volumineuse', 'Anfrage zu groß', 'Solicitud demasiado grande'],
  ['JSON non valido', 'Invalid JSON', 'JSON invalide', 'Ungültiges JSON', 'JSON no válido'],
  ['Inserisci un nome', 'Enter a name', 'Saisissez un nom', 'Namen eingeben', 'Introduce un nombre'],
  ['Accesso richiesto', 'Sign-in required', 'Connexion requise', 'Anmeldung erforderlich', 'Se requiere iniciar sesión'],
  ['Non trovato', 'Not found', 'Introuvable', 'Nicht gefunden', 'No encontrado'],
  ["Il riavvio dall'app non è attivo su questo sistema", 'Restarting from the app is not enabled on this system', "Le redémarrage depuis l'application n'est pas activé sur ce système", 'Neustart über die App ist auf diesem System nicht aktiviert', 'El reinicio desde la app no está activado en este sistema'],
  ['Conferma mancante', 'Confirmation missing', 'Confirmation manquante', 'Bestätigung fehlt', 'Falta la confirmación'],
  ['Utente non trovato', 'User not found', 'Utilisateur introuvable', 'Benutzer nicht gefunden', 'Usuario no encontrado'],
  ['Origine non consentita', 'Origin not allowed', 'Origine non autorisée', 'Herkunft nicht erlaubt', 'Origen no permitido'],
  ['Devi cambiare la password prima di continuare', 'You must change your password before continuing', 'Vous devez changer votre mot de passe avant de continuer', 'Du musst dein Passwort ändern, bevor du fortfährst', 'Debes cambiar la contraseña antes de continuar'],
  ['Riservato agli amministratori', 'Administrators only', 'Réservé aux administrateurs', 'Nur für Administratoren', 'Solo para administradores'],
  ['Telecamera non trovata', 'Camera not found', 'Caméra introuvable', 'Kamera nicht gefunden', 'Cámara no encontrada'],
  ['Non hai il permesso di controllare questa telecamera', 'You are not allowed to control this camera', "Vous n'avez pas l'autorisation de contrôler cette caméra", 'Du darfst diese Kamera nicht steuern', 'No tienes permiso para controlar esta cámara'],
  ['Flusso non consentito', 'Stream not allowed', 'Flux non autorisé', 'Stream nicht erlaubt', 'Flujo no permitido'],
  ['Motore video non raggiungibile', 'Video engine unreachable', 'Moteur vidéo injoignable', 'Video-Engine nicht erreichbar', 'Motor de vídeo inaccesible'],
  ['Ordine non valido', 'Invalid order', 'Ordre invalide', 'Ungültige Reihenfolge', 'Orden no válido'],
  ['Icona non trovata', 'Icon not found', 'Icône introuvable', 'Symbol nicht gefunden', 'Icono no encontrado'],
  // --- persone, soggetti, eventi ---
  ['Persona di destinazione non valida', 'Invalid target person', 'Personne de destination invalide', 'Ungültige Zielperson', 'Persona de destino no válida'],
  ['Si possono unire solo persone con persone e animali della stessa specie', 'Only people with people and animals of the same species can be merged', 'On ne peut fusionner que des personnes avec des personnes et des animaux de la même espèce', 'Es können nur Personen mit Personen und Tiere derselben Art zusammengeführt werden', 'Solo se pueden unir personas con personas y animales de la misma especie'],
  ['Immagine non trovata', 'Image not found', 'Image introuvable', 'Bild nicht gefunden', 'Imagen no encontrada'],
  ['Soggetto di destinazione non valido', 'Invalid target subject', 'Sujet de destination invalide', 'Ungültiges Zielobjekt', 'Sujeto de destino no válido'],
  ['Elenco di eventi non valido', 'Invalid list of events', "Liste d'événements invalide", 'Ungültige Ereignisliste', 'Lista de eventos no válida'],
  ['Evento non trovato', 'Event not found', 'Événement introuvable', 'Ereignis nicht gefunden', 'Evento no encontrado'],
  ["Soggetto non presente nell'evento", 'Subject not in this event', "Sujet absent de l'événement", 'Objekt nicht in diesem Ereignis', 'El sujeto no está en el evento'],
  ['Soggetto non valido', 'Invalid subject', 'Sujet invalide', 'Ungültiges Objekt', 'Sujeto no válido'],
  ['Azione non valida', 'Invalid action', 'Action invalide', 'Ungültige Aktion', 'Acción no válida'],
  // --- telecamere ---
  ["La telecamera risulta offline per l'hub (batteria scarica o fuori portata)", 'The camera is offline for the hub (battery empty or out of range)', 'La caméra est hors ligne pour le hub (batterie vide ou hors de portée)', 'Die Kamera ist für den Hub offline (Akku leer oder außer Reichweite)', 'La cámara figura sin conexión para el hub (batería agotada o fuera de alcance)'],
  ['Questa telecamera non si può riavviare da qui', 'This camera cannot be restarted from here', 'Cette caméra ne peut pas être redémarrée depuis ici', 'Diese Kamera kann von hier nicht neu gestartet werden', 'Esta cámara no se puede reiniciar desde aquí'],
  ['Modalità privacy disponibile solo per telecamere Reolink', 'Privacy mode is only available for Reolink cameras', 'Le mode confidentialité n’est disponible que pour les caméras Reolink', 'Der Privatmodus ist nur für Reolink-Kameras verfügbar', 'El modo privacidad solo está disponible para cámaras Reolink'],
  ['Disponibile solo per telecamere Eufy', 'Only available for Eufy cameras', 'Disponible uniquement pour les caméras Eufy', 'Nur für Eufy-Kameras verfügbar', 'Solo disponible para cámaras Eufy'],
  ['Disponibile solo per telecamere Reolink', 'Only available for Reolink cameras', 'Disponible uniquement pour les caméras Reolink', 'Nur für Reolink-Kameras verfügbar', 'Solo disponible para cámaras Reolink'],
  ['Questa telecamera non si può riavviare da qui', 'This camera cannot be restarted from here', 'Cette caméra ne peut pas être redémarrée depuis ici', 'Diese Kamera kann von hier nicht neu gestartet werden', 'Esta cámara no se puede reiniciar desde aquí'],
  // --- archivio di rete ---
  ['Tipo di archivio non valido', 'Invalid archive type', "Type d'archive invalide", 'Ungültiger Archivtyp', 'Tipo de archivo no válido'],
  ['Percorso SMB non valido: usa \\\\server\\condivisione (senza cartelle: la cartella si indica a parte)', 'Invalid SMB path: use \\\\server\\share (no folders: the folder is set separately)', 'Chemin SMB invalide : utilisez \\\\serveur\\partage (sans dossiers : le dossier est indiqué à part)', 'Ungültiger SMB-Pfad: \\\\server\\freigabe verwenden (ohne Ordner: der Ordner wird separat angegeben)', 'Ruta SMB no válida: usa \\\\servidor\\recurso (sin carpetas: la carpeta se indica aparte)'],
  ['Indirizzo WebDAV non valido (es. https://nas.local/webdav)', 'Invalid WebDAV address (e.g. https://nas.local/webdav)', 'Adresse WebDAV invalide (ex. https://nas.local/webdav)', 'Ungültige WebDAV-Adresse (z. B. https://nas.local/webdav)', 'Dirección WebDAV no válida (p. ej. https://nas.local/webdav)'],
  ['Indica un percorso assoluto (es. /mnt/archivio)', 'Enter an absolute path (e.g. /mnt/archive)', 'Indiquez un chemin absolu (ex. /mnt/archive)', 'Absoluten Pfad angeben (z. B. /mnt/archiv)', 'Indica una ruta absoluta (p. ej. /mnt/archivo)'],
  ["L'archivio non può stare dentro i dati dell'app", 'The archive cannot be inside the app data', "L'archive ne peut pas être dans les données de l'application", 'Das Archiv darf nicht in den App-Daten liegen', 'El archivo no puede estar dentro de los datos de la app'],
  ['Cartella non valida: solo lettere, numeri, spazi, punto, trattino e /', 'Invalid folder: only letters, numbers, spaces, dot, dash and /', 'Dossier invalide : uniquement lettres, chiffres, espaces, point, tiret et /', 'Ungültiger Ordner: nur Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich und /', 'Carpeta no válida: solo letras, números, espacios, punto, guion y /'],
  ['Indica una cartella di destinazione (es. cam-app)', 'Enter a destination folder (e.g. cam-app)', 'Indiquez un dossier de destination (ex. cam-app)', 'Zielordner angeben (z. B. cam-app)', 'Indica una carpeta de destino (p. ej. cam-app)'],
  ['File non valido', 'Invalid file', 'Fichier invalide', 'Ungültige Datei', 'Archivo no válido'],
  ['Percorso non verificato o condivisione non collegata (usa "Verifica collegamento")', 'Path not verified or share not connected (use "Test connection")', 'Chemin non vérifié ou partage non connecté (utilisez « Tester la connexion »)', 'Pfad nicht geprüft oder Freigabe nicht verbunden („Verbindung prüfen“ verwenden)', 'Ruta no verificada o recurso no conectado (usa «Probar conexión»)'],
  ['Copia incompleta', 'Incomplete copy', 'Copie incomplète', 'Unvollständige Kopie', 'Copia incompleta'],
  ['La cartella non esiste (o non è collegata)', 'The folder does not exist (or is not connected)', "Le dossier n'existe pas (ou n'est pas connecté)", 'Der Ordner existiert nicht (oder ist nicht verbunden)', 'La carpeta no existe (o no está conectada)'],
  ['Lettura non coerente', 'Inconsistent read', 'Lecture incohérente', 'Inkonsistentes Lesen', 'Lectura incoherente'],
  ['SMB: {1}', 'SMB: {1}', 'SMB : {1}', 'SMB: {1}', 'SMB: {1}'],
  ['copia non riuscita', 'copy failed', 'copie échouée', 'Kopieren fehlgeschlagen', 'copia fallida'],
  ['SMB: dimensione diversa dopo la copia', 'SMB: size differs after the copy', 'SMB : taille différente après la copie', 'SMB: Größe nach dem Kopieren abweichend', 'SMB: tamaño distinto tras la copia'],
  ['lettura non riuscita', 'read failed', 'lecture échouée', 'Lesen fehlgeschlagen', 'lectura fallida'],
  ['SMB: scrittura non riuscita ({1})', 'SMB: write failed ({1})', 'SMB : écriture échouée ({1})', 'SMB: Schreiben fehlgeschlagen ({1})', 'SMB: escritura fallida ({1})'],
  ['errore', 'error', 'erreur', 'Fehler', 'error'],
  ['tempo scaduto', 'timed out', 'délai dépassé', 'Zeitüberschreitung', 'tiempo agotado'],
  ['WebDAV: utente o password non accettati', 'WebDAV: username or password not accepted', "WebDAV : nom d'utilisateur ou mot de passe refusé", 'WebDAV: Benutzername oder Passwort nicht akzeptiert', 'WebDAV: usuario o contraseña no aceptados'],
  ['WebDAV: cartella non creata (HTTP {1})', 'WebDAV: folder not created (HTTP {1})', 'WebDAV : dossier non créé (HTTP {1})', 'WebDAV: Ordner nicht erstellt (HTTP {1})', 'WebDAV: carpeta no creada (HTTP {1})'],
  ['WebDAV: copia non riuscita (HTTP {1})', 'WebDAV: copy failed (HTTP {1})', 'WebDAV : copie échouée (HTTP {1})', 'WebDAV: Kopieren fehlgeschlagen (HTTP {1})', 'WebDAV: copia fallida (HTTP {1})'],
  ['WebDAV: file non trovato dopo la copia', 'WebDAV: file not found after the copy', 'WebDAV : fichier introuvable après la copie', 'WebDAV: Datei nach dem Kopieren nicht gefunden', 'WebDAV: archivo no encontrado tras la copia'],
  ['WebDAV: lettura non riuscita (HTTP {1})', 'WebDAV: read failed (HTTP {1})', 'WebDAV : lecture échouée (HTTP {1})', 'WebDAV: Lesen fehlgeschlagen (HTTP {1})', 'WebDAV: lectura fallida (HTTP {1})'],
  ['Utente o password non accettati', 'Username or password not accepted', "Nom d'utilisateur ou mot de passe refusé", 'Benutzername oder Passwort nicht akzeptiert', 'Usuario o contraseña no aceptados'],
  ['Il server non risponde come WebDAV (HTTP {1})', 'The server does not answer as WebDAV (HTTP {1})', 'Le serveur ne répond pas comme WebDAV (HTTP {1})', 'Der Server antwortet nicht wie WebDAV (HTTP {1})', 'El servidor no responde como WebDAV (HTTP {1})'],
  ['Scrittura non riuscita (HTTP {1})', 'Write failed (HTTP {1})', 'Écriture échouée (HTTP {1})', 'Schreiben fehlgeschlagen (HTTP {1})', 'Escritura fallida (HTTP {1})'],
  ['Archivio non configurato', 'Archive not configured', 'Archive non configurée', 'Archiv nicht eingerichtet', 'Archivo no configurado'],
  ["Filmato non trovato nell'archivio", 'Clip not found in the archive', "Vidéo introuvable dans l'archive", 'Video im Archiv nicht gefunden', 'Vídeo no encontrado en el archivo'],
  ['smbclient non installato nel CT (apt install smbclient)', 'smbclient is not installed in the container (apt install smbclient)', "smbclient n'est pas installé dans le conteneur (apt install smbclient)", 'smbclient ist im Container nicht installiert (apt install smbclient)', 'smbclient no está instalado en el contenedor (apt install smbclient)'],
  // --- utenti e password ---
  ['La password deve avere almeno 8 caratteri', 'The password must have at least 8 characters', 'Le mot de passe doit contenir au moins 8 caractères', 'Das Passwort muss mindestens 8 Zeichen haben', 'La contraseña debe tener al menos 8 caracteres'],
  ['Password troppo lunga', 'Password too long', 'Mot de passe trop long', 'Passwort zu lang', 'Contraseña demasiado larga'],
  ['Troppi tentativi: riprova tra {1} minuti', 'Too many attempts: try again in {1} minutes', 'Trop de tentatives : réessayez dans {1} minutes', 'Zu viele Versuche: in {1} Minuten erneut versuchen', 'Demasiados intentos: vuelve a intentarlo en {1} minutos'],
  ['Utente o password non corretti', 'Wrong username or password', "Nom d'utilisateur ou mot de passe incorrect", 'Benutzername oder Passwort falsch', 'Usuario o contraseña incorrectos'],
  ['Nome utente: da 3 a 32 caratteri tra lettere, numeri, punto, trattino e trattino basso', 'Username: 3 to 32 characters from letters, numbers, dot, dash and underscore', "Nom d'utilisateur : de 3 à 32 caractères parmi lettres, chiffres, point, tiret et tiret bas", 'Benutzername: 3 bis 32 Zeichen aus Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich', 'Nombre de usuario: de 3 a 32 caracteres entre letras, números, punto, guion y guion bajo'],
  ['Ruolo non valido', 'Invalid role', 'Rôle invalide', 'Ungültige Rolle', 'Rol no válido'],
  ['Esiste già un utente con questo nome', 'A user with this name already exists', 'Un utilisateur portant ce nom existe déjà', 'Ein Benutzer mit diesem Namen existiert bereits', 'Ya existe un usuario con este nombre'],
  ['Deve restare almeno un amministratore attivo', 'At least one active administrator must remain', 'Il doit rester au moins un administrateur actif', 'Mindestens ein aktiver Administrator muss bleiben', 'Debe quedar al menos un administrador activo'],
  ['Non puoi disabilitare il tuo stesso utente', 'You cannot disable your own user', 'Vous ne pouvez pas désactiver votre propre utilisateur', 'Du kannst deinen eigenen Benutzer nicht deaktivieren', 'No puedes desactivar tu propio usuario'],
  ['La password attuale non è corretta', 'The current password is not correct', "Le mot de passe actuel n'est pas correct", 'Das aktuelle Passwort ist nicht korrekt', 'La contraseña actual no es correcta'],
  ['La nuova password deve essere diversa da quella attuale', 'The new password must be different from the current one', "Le nouveau mot de passe doit être différent de l'actuel", 'Das neue Passwort muss sich vom aktuellen unterscheiden', 'La nueva contraseña debe ser distinta de la actual'],
  ['Non puoi eliminare il tuo stesso utente', 'You cannot delete your own user', 'Vous ne pouvez pas supprimer votre propre utilisateur', 'Du kannst deinen eigenen Benutzer nicht löschen', 'No puedes eliminar tu propio usuario'],
  ['Servono 3 domande con le relative risposte', '3 questions with their answers are required', 'Il faut 3 questions avec leurs réponses', '3 Fragen mit den zugehörigen Antworten sind erforderlich', 'Se necesitan 3 preguntas con sus respuestas'],
  ['Ogni domanda: da 5 a 120 caratteri; ogni risposta: da 3 a 100', 'Each question: 5 to 120 characters; each answer: 3 to 100', 'Chaque question : de 5 à 120 caractères ; chaque réponse : de 3 à 100', 'Jede Frage: 5 bis 120 Zeichen; jede Antwort: 3 bis 100', 'Cada pregunta: de 5 a 120 caracteres; cada respuesta: de 3 a 100'],
  ['Le tre domande e le tre risposte devono essere diverse', 'The three questions and the three answers must be different', 'Les trois questions et les trois réponses doivent être différentes', 'Die drei Fragen und die drei Antworten müssen verschieden sein', 'Las tres preguntas y las tres respuestas deben ser distintas'],
  ['Risposte non corrette o recupero non disponibile', 'Wrong answers or recovery not available', 'Réponses incorrectes ou récupération indisponible', 'Falsche Antworten oder Wiederherstellung nicht verfügbar', 'Respuestas incorrectas o recuperación no disponible'],
  ['Password non corretta', 'Wrong password', 'Mot de passe incorrect', 'Falsches Passwort', 'Contraseña incorrecta'],
  // --- Reolink / Baichuan ---
  ['Baichuan: porta 9000 non raggiungibile', 'Baichuan: port 9000 unreachable', 'Baichuan : port 9000 injoignable', 'Baichuan: Port 9000 nicht erreichbar', 'Baichuan: puerto 9000 inaccesible'],
  ['Baichuan: nessuna risposta', 'Baichuan: no answer', 'Baichuan : aucune réponse', 'Baichuan: keine Antwort', 'Baichuan: sin respuesta'],
  ['Baichuan: connessione chiusa', 'Baichuan: connection closed', 'Baichuan : connexion fermée', 'Baichuan: Verbindung geschlossen', 'Baichuan: conexión cerrada'],
  ['Baichuan: nonce non ricevuto', 'Baichuan: nonce not received', 'Baichuan : nonce non reçu', 'Baichuan: Nonce nicht empfangen', 'Baichuan: nonce no recibido'],
  ['Accesso Baichuan rifiutato ({1})', 'Baichuan login refused ({1})', 'Connexion Baichuan refusée ({1})', 'Baichuan-Anmeldung abgelehnt ({1})', 'Acceso Baichuan rechazado ({1})'],
  ['Accesso Baichuan sospeso ({1})', 'Baichuan login suspended ({1})', 'Connexion Baichuan suspendue ({1})', 'Baichuan-Anmeldung ausgesetzt ({1})', 'Acceso Baichuan suspendido ({1})'],
  ['La telecamera ha rifiutato il comando ({1})', 'The camera refused the command ({1})', 'La caméra a refusé la commande ({1})', 'Die Kamera hat den Befehl abgelehnt ({1})', 'La cámara rechazó el comando ({1})'],
  ['Risposta non valida (HTTP {1})', 'Invalid response (HTTP {1})', 'Réponse invalide (HTTP {1})', 'Ungültige Antwort (HTTP {1})', 'Respuesta no válida (HTTP {1})'],
  ['Accesso rifiutato dalla telecamera ({1}). Nuovo tentativo possibile tra {2} s.', 'Login refused by the camera ({1}). You can try again in {2} s.', 'Connexion refusée par la caméra ({1}). Nouvel essai possible dans {2} s.', 'Anmeldung von der Kamera abgelehnt ({1}). Erneuter Versuch in {2} s möglich.', 'Acceso rechazado por la cámara ({1}). Se puede reintentar en {2} s.'],
  ['Accesso rifiutato dalla telecamera ({1}).', 'Login refused by the camera ({1}).', 'Connexion refusée par la caméra ({1}).', 'Anmeldung von der Kamera abgelehnt ({1}).', 'Acceso rechazado por la cámara ({1}).'],
  ['API Reolink non raggiungibile su {1}: {2}', 'Reolink API unreachable on {1}: {2}', 'API Reolink injoignable sur {1} : {2}', 'Reolink-API auf {1} nicht erreichbar: {2}', 'API de Reolink inaccesible en {1}: {2}'],
  ['Gruppo non modificabile', 'Group cannot be changed', 'Groupe non modifiable', 'Gruppe nicht änderbar', 'Grupo no modificable'],
  ['Impostazione non supportata da questa telecamera', 'Setting not supported by this camera', 'Réglage non pris en charge par cette caméra', 'Einstellung von dieser Kamera nicht unterstützt', 'Ajuste no compatible con esta cámara'],
  ['Campo non modificabile: {1}', 'Field cannot be changed: {1}', 'Champ non modifiable : {1}', 'Feld nicht änderbar: {1}', 'Campo no modificable: {1}'],
  ['Valore non valido: {1}', 'Invalid value: {1}', 'Valeur invalide : {1}', 'Ungültiger Wert: {1}', 'Valor no válido: {1}'],
  ['La telecamera ha rifiutato la modifica ({1})', 'The camera refused the change ({1})', 'La caméra a refusé la modification ({1})', 'Die Kamera hat die Änderung abgelehnt ({1})', 'La cámara rechazó el cambio ({1})'],
  ['Comando rifiutato ({1})', 'Command refused ({1})', 'Commande refusée ({1})', 'Befehl abgelehnt ({1})', 'Comando rechazado ({1})'],
  ['Operazione PTZ non valida', 'Invalid PTZ operation', 'Opération PTZ invalide', 'Ungültige PTZ-Aktion', 'Operación PTZ no válida'],
  ['Istantanea non valida', 'Invalid snapshot', 'Instantané invalide', 'Ungültiger Schnappschuss', 'Instantánea no válida'],
  ['La telecamera ha rifiutato il riavvio ({1})', 'The camera refused to restart ({1})', 'La caméra a refusé le redémarrage ({1})', 'Die Kamera hat den Neustart abgelehnt ({1})', 'La cámara rechazó el reinicio ({1})'],
  // --- marche e campi ---
  ['Marca non supportata', 'Brand not supported', 'Marque non prise en charge', 'Marke nicht unterstützt', 'Marca no compatible'],
  ['Campo obbligatorio: {1}', 'Required field: {1}', 'Champ obligatoire : {1}', 'Pflichtfeld: {1}', 'Campo obligatorio: {1}'],
  ['Indirizzo non valido (solo IP o nome host)', 'Invalid address (IP or host name only)', "Adresse invalide (IP ou nom d'hôte uniquement)", 'Ungültige Adresse (nur IP oder Hostname)', 'Dirección no válida (solo IP o nombre de host)'],
  ['{1}: deve iniziare con rtsp://, http://, rtmp:// o onvif://', '{1}: must start with rtsp://, http://, rtmp:// or onvif://', '{1} : doit commencer par rtsp://, http://, rtmp:// ou onvif://', '{1}: muss mit rtsp://, http://, rtmp:// oder onvif:// beginnen', '{1}: debe empezar por rtsp://, http://, rtmp:// u onvif://'],
  // --- Eufy ---
  ['Sessione chiusa', 'Session closed', 'Session fermée', 'Sitzung geschlossen', 'Sesión cerrada'],
  ['La telecamera non ha risposto', 'The camera did not answer', "La caméra n'a pas répondu", 'Die Kamera hat nicht geantwortet', 'La cámara no respondió'],
  ['Impostazione non supportata da questo modello', 'Setting not supported by this model', 'Réglage non pris en charge par ce modèle', 'Einstellung von diesem Modell nicht unterstützt', 'Ajuste no compatible con este modelo'],
  ['Valore non valido', 'Invalid value', 'Valeur invalide', 'Ungültiger Wert', 'Valor no válido'],
  ['La telecamera ha rifiutato la modifica (codice {1})', 'The camera refused the change (code {1})', 'La caméra a refusé la modification (code {1})', 'Die Kamera hat die Änderung abgelehnt (Code {1})', 'La cámara rechazó el cambio (código {1})'],
  ['nessuna risposta', 'no answer', 'aucune réponse', 'keine Antwort', 'sin respuesta'],
  ['Telecamera non trovata in rete (a riposo?)', 'Camera not found on the network (asleep?)', 'Caméra introuvable sur le réseau (en veille ?)', 'Kamera im Netzwerk nicht gefunden (im Ruhezustand?)', 'Cámara no encontrada en la red (¿dormida?)'],
  ['Accesso Eufy non configurato (tools/eufy-login)', 'Eufy login not set up (tools/eufy-login)', 'Connexion Eufy non configurée (tools/eufy-login)', 'Eufy-Anmeldung nicht eingerichtet (tools/eufy-login)', 'Acceso Eufy sin configurar (tools/eufy-login)'],
  ['La telecamera non si è svegliata', 'The camera did not wake up', "La caméra ne s'est pas réveillée", 'Die Kamera ist nicht aufgewacht', 'La cámara no se despertó'],
  // --- Home Assistant ---
  ['Indirizzo di Home Assistant non valido (es. http://192.168.1.10:8123)', 'Invalid Home Assistant address (e.g. http://192.168.1.10:8123)', 'Adresse Home Assistant invalide (ex. http://192.168.1.10:8123)', 'Ungültige Home-Assistant-Adresse (z. B. http://192.168.1.10:8123)', 'Dirección de Home Assistant no válida (p. ej. http://192.168.1.10:8123)'],
  ['Inserisci il token di accesso a lungo termine', 'Enter the long-lived access token', 'Saisissez le jeton d’accès longue durée', 'Langzeit-Zugriffstoken eingeben', 'Introduce el token de acceso de larga duración'],
  ['Token non valido', 'Invalid token', 'Jeton invalide', 'Ungültiges Token', 'Token no válido'],
  ['Home Assistant non configurato', 'Home Assistant not configured', 'Home Assistant non configuré', 'Home Assistant nicht eingerichtet', 'Home Assistant sin configurar'],
  ['Home Assistant ha rifiutato il token', 'Home Assistant rejected the token', 'Home Assistant a refusé le jeton', 'Home Assistant hat das Token abgelehnt', 'Home Assistant rechazó el token'],
  ['Home Assistant: errore {1}', 'Home Assistant: error {1}', 'Home Assistant : erreur {1}', 'Home Assistant: Fehler {1}', 'Home Assistant: error {1}'],
  ['Questa entità non si può comandare', 'This entity cannot be controlled', "Cette entité ne peut pas être commandée", 'Diese Entität kann nicht gesteuert werden', 'Esta entidad no se puede controlar'],
  ['Al massimo {1} icone per telecamera', 'At most {1} icons per camera', 'Au maximum {1} icônes par caméra', 'Höchstens {1} Symbole pro Kamera', 'Como máximo {1} iconos por cámara'],
  ['Entità non valida: {1}', 'Invalid entity: {1}', 'Entité invalide : {1}', 'Ungültige Entität: {1}', 'Entidad no válida: {1}'],
  ['Entità ripetuta: {1}', 'Duplicate entity: {1}', 'Entité en double : {1}', 'Doppelte Entität: {1}', 'Entidad repetida: {1}'],
  // --- riconoscimento e varie ---
  ['modello mancante: {1}', 'missing model: {1}', 'modèle manquant : {1}', 'Modell fehlt: {1}', 'falta el modelo: {1}'],
  ['JPEG non valido', 'Invalid JPEG', 'JPEG invalide', 'Ungültiges JPEG', 'JPEG no válido'],
  ['ffprobe: video non leggibile', 'ffprobe: video unreadable', 'ffprobe : vidéo illisible', 'ffprobe: Video nicht lesbar', 'ffprobe: vídeo ilegible'],
  ['Modelli o runtime non installati', 'Models or runtime not installed', 'Modèles ou runtime non installés', 'Modelle oder Laufzeit nicht installiert', 'Modelos o runtime sin instalar'],
];

const LANG_INDEX = { it: 0, en: 1, fr: 2, de: 3, es: 4 };
const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

// Voci esatte (senza variabili) in una mappa; quelle con {1}… in un elenco di espressioni regolari.
const exact = new Map();
const patterns = [];
for (const row of ROWS) {
  if (/\{\d\}/.test(row[0])) {
    const re = new RegExp(`^${esc(row[0]).replace(/\\?\{(\d)\\?\}/g, '(?<g$1>.+?)').replace(/\{/g, '\\{')}$`, 's');
    patterns.push([re, row]);
  } else if (!exact.has(row[0])) {
    exact.set(row[0], row);
  }
}
// Le voci più specifiche (più testo fisso) vanno provate per prime: "SMB: scrittura non riuscita ({1})" prima di "SMB: {1}".
patterns.sort((a, b) => b[1][0].replace(/\{\d\}/g, '').length - a[1][0].replace(/\{\d\}/g, '').length);

/** Le lingue supportate: `it` (predefinita), `en`, `fr`, `de`, `es`. Legge X-Lang, poi Accept-Language. */
export function langOf(req) {
  const pick = (v) => { const l = String(v || '').slice(0, 2).toLowerCase(); return l in LANG_INDEX ? l : null; };
  const x = pick(req.headers['x-lang']);
  if (x) return x;
  for (const part of String(req.headers['accept-language'] || '').split(',')) { const l = pick(part.trim()); if (l) return l; }
  return 'it';
}

/** Traduce un messaggio d'errore italiano nella lingua `lang`; se non lo conosce lo restituisce com'è. */
export function localize(message, lang) {
  if (typeof message !== 'string' || !message || !(lang in LANG_INDEX) || lang === 'it') return message;
  const i = LANG_INDEX[lang];
  const hit = exact.get(message);
  if (hit) return hit[i];
  for (const [re, row] of patterns) {
    const m = re.exec(message);
    if (!m) continue;
    // Le parti variabili possono essere a loro volta messaggi noti (es. "SMB: copia non riuscita").
    return row[i].replace(/\{(\d)\}/g, (_, n) => localize(m.groups[`g${n}`] ?? '', lang));
  }
  return message;
}

/** Vero se il messaggio (con le variabili scritte come {1}, {2}…) ha una voce nella tabella. */
export const isKnown = (message) => exact.has(message) || patterns.some(([re]) => re.test(message));
