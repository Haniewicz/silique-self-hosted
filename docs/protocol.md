# Silique Protocol v1

Discovery: `GET /.well-known/silique`. Klient wymaga `api_version=1`, `e2ee=true`, `revision_dag=true`.

## Konta

`POST /v1/auth/register`, `POST /v1/auth/login`: email, password (min. 12 znaków), deviceId UUID, deviceName. Pierwsze konto tworzy się wyłącznie przez `/v1/auth/register` z aplikacji: pierwsza rejestracja zwraca 201 (konto + sesja), a każda kolejna — niezależnie od adresu — zawsze kończy się `403` z treścią `single-user` (`This is a single-user server: only one account is allowed`). Serwer obsługuje dokładnie jedno konto; rejestracja jest first-user-wins i po jej zamknięciu nie ma żadnego systemu zaproszeń (invite) ani trybu wielu kont. Limit egzekwowany jest w transakcji (`BEGIN IMMEDIATE`), więc równoległe rejestracje nie ominą limitu. Losowy token 256-bitowy, na serwerze wyłącznie SHA-256, ważny 30 dni, związany z urządzeniem. `POST /v1/auth/logout` unieważnia sesję.

`GET /v1/account` zwraca accountEnvelope. `PUT /v1/account/envelope` przyjmuje nieprzezroczyste envelope i expected (null przy inicjalizacji). Atomowy compare-and-swap chroni klucze przed nadpisaniem przez równoległą inicjalizację.

`GET /v1/devices`; `DELETE /v1/devices/:id` cofa dostęp i usuwa sesje. Logowanie z unieważnionym ID jest odrzucane.

## Vaulty i rewizje

`GET /v1/vaults`; `PUT /v1/vaults/:id`: keyWrap, metadata, expectedVersion (0 dla nowego vaulta). Odpowiedź zawiera kolejną wersję. Wszystkie operacje sprawdzają właściciela konta.

`POST /v1/vaults/:id/batches`:

```json
{"batchId":"UUID","revisions":[{"id":"UUID","noteId":"opaque-id","parents":[],"payload":"opaque AEAD envelope"}]}
```

Do 100 rewizji, żądanie do 4 MB, payload do 2 mln znaków. Rodzice muszą należeć do tej samej notatki i vaulta. Serwer w jednej transakcji zapisuje rewizje, aktualizuje głowy DAG i utrwala potwierdzenie batcha. Równoległe gałęzie są zachowywane, brak last-write-wins. Ten sam batchId i identyczne żądanie zwracają to samo potwierdzenie; inny payload zwraca 409. Rodzice mogą być dodani wcześniej w tym samym batchu.

`GET /v1/vaults/:id/changes?cursor=0&limit=100` zwraca revisions, monotoniczny cursor, hasMore. Kursor osobny dla każdego vaulta. Pobierz wszystkie strony przed scalaniem. Usunięcie, tytuł, folder, tagi i dziennik są zaszyfrowane wewnątrz payloadu. ID dziennika: HMAC-SHA256(VaultKey, `journal:YYYY-MM-DD`).

Klient utrwala dokładny zaszyfrowany batch przed transmisją. Usuwa go po weryfikacji kompletnego potwierdzenia. Utrata odpowiedzi wymaga ponowienia tego samego batcha także po restarcie. Wspólny przodek umożliwia three-way merge; sprzeczne wersje otrzymują deterministyczne kopie konfliktowe. Historia pozostaje niezmienna.

## Parowanie X25519

`POST /v1/pairings`: publicKey (32 B Base64) zalogowanego nowego urządzenia. `GET /v1/pairings`: żądania tylko tego konta, ważne 10 minut. Drugie urządzenie przesyła publicKey do `POST /v1/pairings/:id/offer` (CAS, inne urządzenie). X25519 + HKDF-SHA256 używa kontekstu wiążącego konto, pairingId, oba deviceId i oba klucze publiczne. Użytkownik porównuje pełny 16-znakowy kod na obu urządzeniach. Dopiero po potwierdzeniu starsze urządzenie wysyła AES-GCM kopertę Account Master Key do `POST /v1/pairings/:id/approve`. Klient weryfikuje kontekst i własny klucz publiczny. Serwer nie otrzymuje prywatnych kluczy ani jawnego klucza konta.

## Przyszły Web

Domena i kryptografia nie importują dart:io. NoteStorage, KeyStore, CryptoProvider, SyncTransport, UpdateProvider są granicami adapterów. API jest wersjonowane, CORS jawny. Web będzie wymagał HTTPS, przeglądarkowego magazynu kluczy, CSP i polityki dostarczania kodu, cookies/CSRF. Aktualnie brak webowego UI i uwierzytelniania cookies.


## Trwałe usuwanie (serwer 0.2.1)

`DELETE /v1/vaults/:id/notes/:noteId` wymaga sesji właściciela vaulta. Atomowo rejestruje nieodwracalne usunięcie identyfikatora, kasuje jego końcówki historii i rewizje; operacja jest idempotentna. Serwer nie odszyfrowuje notatki i nie zna stanu lokalnego kosza — potwierdzenie i wymóg przeniesienia do kosza realizuje klient.

Każda odpowiedź `GET .../changes` zawiera dodatkowe `purged: string[]`, niezależnie od kursora. Klient usuwa dla tych identyfikatorów dokument i historię. Nowe rewizje dla trwale usuniętych identyfikatorów są potwierdzane bez zapisu, aby zaległa kolejka urządzenia mogła się opróżnić; następny odczyt zmian usuwa starą kopię u klienta. Nowa notatka wymaga nowego identyfikatora. Usunięcie nie kasuje wcześniejszych kopii zapasowych ani danych pozostających na urządzeniu offline.


## Załączniki zdjęć (serwer 0.2.2)

Discovery sygnalizuje `features.image_attachments=true`. Załączniki są niemutowalne, dostępne wyłącznie w vaulcie właściciela. Klient dzieli oryginał na fragmenty 512 KiB, szyfruje każdy AES-GCM z AAD wiążącym vault, identyfikator obrazu i numer fragmentu. Osobny szyfrowany manifest wiąże identyfikatory, MIME, liczbę bajtów i fragmentów oraz SHA-256 oryginału.

- `PUT /v1/vaults/:id/images/:assetId/chunks/:index` — `{noteId,payload}`; to samo żądanie jest idempotentne, inna zawartość istniejącego fragmentu daje 409.
- `PUT /v1/vaults/:id/images/:assetId` — `{noteId,manifest,chunkCount}`; finalizacja dopiero po zapisaniu wszystkich kolejnych fragmentów. Gotowego manifestu nie można nadpisać.
- `GET /v1/vaults/:id/images/:assetId` — `{noteId,manifest,chunkCount}`; tylko po finalizacji.
- `GET /v1/vaults/:id/images/:assetId/chunks/:index` — `{payload}`; tylko po finalizacji, z autoryzacją właściciela vaulta.

Rewizje w batchach mogą zawierać dodatkowe `images: UUID[]`. Załączniki muszą istnieć przed przyjęciem rewizji; odniesienia pozostają przez historię notatki. Trwałe usunięcie notatki usuwa jej odniesienia, nieużywane już obiekty i fragmenty. Obraz używany przez inną notatkę lub jej historię jest zachowany. Wysyłanie danych dla już trwale usuniętej notatki otrzymuje `{purged:true}` bez tworzenia nowych obiektów. Nie ma limitu wielkości całego zdjęcia; obecne limity HTTP dotyczą pojedynczych zaszyfrowanych fragmentów.


## Nazwy urządzeń

`PUT /v1/devices/:id/name` przyjmuje `{name}` i wymaga aktywnej sesji właściciela. Nazwa jest przycinana, ma 1–80 znaków i zapisuje się trwale w rekordzie urządzenia; `GET /v1/devices` zwraca ją innym klientom tego samego konta. Obce lub unieważnione urządzenie daje 404. Zmiana nie modyfikuje identyfikatora ani kluczy urządzenia.

## Powiadomienia o zmianach (serwer 0.2.3, opcjonalne)

Discovery ogłasza `features.change_notifications=true`. `GET /v1/events` z Bearer tokenem zwraca wyłącznie `{cursor: string}`. Kolejne `GET /v1/events?since=<cursor>` czeka maksymalnie 15 s lub do zmiany we własnym koncie. Taki sam kursor oznacza brak zmian, inny kursor wymaga zwykłej synchronizacji. Kursor jest efemerycznym sygnałem unieważnienia, nie kursorem paginacji rewizji; nie wolno zapisywać go jako kursora vaulta. Restart serwera zmienia kursor.

Endpoint nie zawiera treści notatek ani identyfikatorów innych kont. Sesja sprawdzana przed oczekiwaniem i przed odpowiedzią; rozłączenie i zamknięcie serwera zwalniają słuchacza. Limit: 32 oczekiwania na konto i 2048 globalnie. Stary serwer zwraca 404, więc klient wraca do synchronizacji co 25 s. Pomiędzy wywołaniami klient pozostawia jedno żądanie oczekujące, anuluje je w tle i używa ograniczonych ponowień po błędach. Pełna kontrola co 60 s pozostaje zabezpieczeniem.

## Usuwanie całego vaulta (opcjonalne rozszerzenie)

Discovery `/.well-known/silique` ogłasza `features.vault_deletion=true`. Dopiero klient
obsługujący ten kontrakt może proponować usunięcie zsynchronizowanego vaulta.
`DELETE /v1/vaults/:id` przyjmuje wyłącznie `{expectedVersion: integer >= 0}`.
Wymaga aktywnej sesji właściciela; nieznany identyfikator daje 404, zmieniona
wersja 409. Nazwa i świadome potwierdzenie są weryfikowane przez klienta;
serwer nie otrzymuje jawnej nazwy ani hasła.

Jedna transakcja utrwala `purged_vaults(id,user_id,deleted_at)` i usuwa vault,
wrap klucza, zaszyfrowane metadane, wszystkie głowy i rewizje (także ukryte
koperty i konfigurację), znaczniki usuniętych notatek oraz wszystkie obrazy,
fragmenty i odniesienia, w tym nieukończone przesyłania. Usuwa też przypisane
potwierdzenia batchy. Stare potwierdzenia są przypisywane przy otwarciu bazy,
o ile istnieją jeszcze identyfikujące je rewizje. Historyczne osierocone
potwierdzenia zawierające tylko hash i zaakceptowane UUID pozostają — nie
można bezpiecznie przypisać ich vaultowi; nie zawierają treści ani kluczy.

Potwierdzenie po COMMIT to `{deleted:true,vaultId:UUID}`; ponowienie zwraca tę
samą odpowiedź niezależnie od dawnej wersji. `GET /v1/vaults` oprócz `vaults`
zwraca `deletedVaults: UUID[]` konta niezależnie od kursorów rewizji. Klient
musi zastosować je przed wysyłką, również dla zablokowanych vaultów. Pozostałe
trasy vaulta, w tym PUT z wersją 0, stare batche i odczyty/zapisy obrazów,
zwracają `410 {error:'vault_deleted'}`. Zatwierdzone DELETE budzi powiadomienia
`/v1/events` konta. Nowy vault wymaga nowego UUID.

Schemat jest addytywny. Trwałe triggery blokują INSERT/zmianę ID na wycofany
UUID również po rollbacku samego kodu do wersji bez obsługi tombstones.
Taki stary kod nie propaguje jednak usunięcia klientom i może zwracać 500
zamiast 410 — po usunięciach trzeba używać kodu świadomego tego kontraktu.
NIE usuwać tabeli/triggerów ani nie odtwarzać backupu sprzed usunięcia bez
zachowania i ponownego zastosowania pełnej listy tombstones. Sam backup sprzed
DELETE może zawierać usuniętą treść i klucze.

Zakres to dane w bieżących tabelach serwera i późniejsze wycofanie na zgodnych
połączonych klientach. Nie jest to gwarancja usunięcia kopii offline, starych
klientów, eksportów, snapshotów systemu/SSD ani backupów objętych dotychczasową
retencją. Testy używają wyłącznie syntetycznej bazy.
