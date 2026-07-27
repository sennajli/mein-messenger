# Ende-zu-Ende-Verschlüsselung – was sich geändert hat

## ⚠️ Zuerst: Sicherheitsvorfall
Die hochgeladene `serviceAccountKey.json` enthält einen echten privaten Firebase-Schlüssel.
Bitte **sofort**:
1. Firebase Console → Projekteinstellungen → Dienstkonten → diesen Schlüssel widerrufen, neuen erzeugen
2. Prüfen, ob die Datei in einem Git-Repo (auch in der Historie!) gelandet ist
3. `.gitignore` enthält `serviceAccountKey.json` bereits – gut so, aber das schützt nur *zukünftige* Commits

## Architektur
- **Schlüsselerzeugung:** Beim ersten App-Start pro Gerät wird ein ECDH-P256-Schlüsselpaar erzeugt
  (`crypto.subtle.generateKey`). Der private Schlüssel wird als JWK in `localStorage`
  (`jm_privkey`) gespeichert und verlässt den Browser nie. Der öffentliche Schlüssel geht
  über `/api/keys/update` an den Server und wird in Firestore beim Nutzer gespeichert.
- **1:1-Chats:** Sender und Empfänger leiten über ECDH denselben AES-256-GCM-Schlüssel ab
  (`ECDH(meinPriv, ihrPub) === ECDH(ihrPriv, meinPub)`). Text, Bilder UND Sprachnachrichten
  werden damit verschlüsselt (`ct`/`iv`, `ctImage`/`ivImage`, `ctAudio`/`ivAudio`) bevor sie
  den Server erreichen. Firestore/Server sehen nur diese Blobs.
- **Gruppen:** Beim Erstellen wird ein zufälliger AES-256-Schlüssel erzeugt und für jedes
  Mitglied einzeln mit dessen abgeleitetem ECDH-Schlüssel "eingepackt" (auch für den Ersteller
  selbst, über ECDH mit sich selbst – mathematisch gültig und getestet). Der Server speichert
  pro Mitglied nur dessen eigenes verschlüsseltes Paket und gibt niemandem die Pakete der
  anderen heraus (`groupForMember()` in server.js).
- Alle Krypto-Grundoperationen wurden in `crypto_test.mjs`-artiger Form gegen echtes
  Web-Crypto getestet (1:1, Gruppe, Selbst-Verschlüsselung, Ablehnung falscher Schlüssel).

## Ehrliche Einschränkungen (wie besprochen)
- **Neues Gerät/Browser** → neuer Schlüssel, alte Nachrichten dort nicht lesbar (auf dem
  alten Gerät weiterhin schon). Die App zeigt dabei einen Hinweis-Toast.
- **Aus Gruppe entfernte Person** kann alte, bereits entschlüsselte Nachrichten weiterhin
  lesen (kein Schlüssel-Rotation-Mechanismus implementiert – wäre der nächste Ausbauschritt).
- **Bilder, Sprachnachrichten sind jetzt ebenfalls Ende-zu-Ende verschlüsselt.** Nur noch
  Metadaten bleiben für den Server sichtbar (wer mit wem chattet, Zeitstempel, Reaktionen als
  Emoji, Lesebestätigungen, Tippanzeige) – wie bei praktisch jedem E2E-Messenger (z.B. Signal),
  da der Server Nachrichten zustellen und Empfänger benachrichtigen muss.
- **Sprachnachrichten in Gruppen** wurden vorher schon nicht unterstützt (nur 1:1) – das war
  ein bestehendes Verhalten, unabhängig von der Verschlüsselung, das ich unverändert gelassen habe.
- Server-seitige Endpunkte für "Mitglied zu Gruppe hinzufügen/entfernen" wurden für die
  Schlüsselverteilung vorbereitet (`newWrappedKeys`), aber es gibt aktuell noch keine
  Client-UI dafür – die gab es vorher schon nicht, das ist unabhängig von dieser Änderung.

## Geänderte Dateien
- `server.js` – neue Route `/api/keys/update`, `publicKey`-Feld überall wo Nutzer/Kontakte
  zurückgegeben werden, Nachrichten speichern `ct`/`iv` statt `text`, Gruppen speichern
  eingepackte Schlüssel pro Mitglied.
- `index.html` – neues Krypto-Modul (eigener `<script>`-Block ganz oben), `sendMessage`,
  `openChat`, `openGroupChat`, der WebSocket-Handler und `createGroup` verschlüsseln/
  entschlüsseln jetzt clientseitig.
