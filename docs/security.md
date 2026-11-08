# Szyfrowanie i granice bezpieczeństwa

Losowy Account Master Key 256-bitowy, niezależny Vault Key 256-bitowy dla każdego vaulta. AES-256-GCM z losowym nonce i AAD wiążącym wersję, vault, notatkę, rewizję i rodziców. Modyfikacja lub podstawienie danych powoduje błąd uwierzytelnienia.

Standardowy Vault Key jest opakowany kluczem konta na serwerze, a lokalnie osobnym kluczem instalacji w systemowym magazynie sekretów. Chroniony Vault Key jest opakowany wyłącznie Argon2id z dodatkowego hasła (64 MiB, 3 iteracje, parallelism 1, sól 16 B) oraz osobną kopertą odzyskiwania z losowym kluczem. Klucz konta nie otwiera takiego vaulta. Zmiana hasła przepakowuje klucz, bez szyfrowania od nowa treści; CAS chroni równoległe aktualizacje.

Account Recovery Key jest osobny od klucza głównego. Hasło logowania nie jest kluczem E2EE. Parowanie używa X25519 i ręcznej weryfikacji pełnego kodu; serwer nie może sam zatwierdzić zgodności kodów.

Chronione tytuły, foldery, tagi i treść są zaszyfrowane również w lokalnej bazie. Nie tworzymy jawnych .md ani jawnego indeksu chronionego vaulta. Odszyfrowane wyszukiwanie działa w pamięci. Standardowe vaulty mają jawne kopie Markdown i wymagają ochrony dysku po stronie systemu. SQLite jest zapisem autorytatywnym; kopie .md są odtwarzalne. Import/eksport są jawne, brak automatycznego obserwowania zewnętrznych zmian .md.

Cofnięcie urządzeniu dostępu nie usuwa uprzednio pobranych danych. Pełna rotacja skompromitowanego klucza i historii jest dalszym etapem. Serwer widzi identyfikatory, rozmiary, czas i powiązania rewizji; może opóźniać lub usuwać dane. Brak zewnętrznego dziennika transparentności. Przejęte urządzenie może odczytać odblokowane dane, Dart nie gwarantuje wyzerowania wszystkich kopii w RAM. Zdalne obrazy Markdown nie są pobierane automatycznie.

Domyślnie HTTPS. Na prośbę użytkownika dopuszczono HTTP dla loopback i sieci prywatnych; poufność zapewnia aktywny VPN (Tailscale/WireGuard) i ACL. Inne HTTP jest odrzucane. Wersja przeglądarkowa będzie wymagała HTTPS.

Nie ma resetu hasła e-mailem (SMTP nie skonfigurowano), załączników ani audytu produkcyjnego. Kopie zapasowe i zapisanie kluczy odzyskiwania pozostają konieczne.
