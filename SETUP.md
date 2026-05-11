# Setup (WSL/Ubuntu)

Questa configurazione usa `planning-as-a-service` dentro Ubuntu, non nella cartella Windows.

## Prerequisiti

- Node.js 18+ con `npm`
- Docker con `docker compose`
- `git`

## Installazione

1. Apri WSL/Ubuntu e vai in `Project`.
2. Esegui `npm run setup`.
3. Inserisci il token in `.env` (oppure lo fornisci a runtime).

`npm run setup`:
- clona `planning-as-a-service` in `$HOME/tools/planning-as-a-service`;
- crea i file `.env` mancanti da `.env.example`;
- installa le dipendenze Node del progetto.

## Avvio

Esegui `npm start`.

Per default lo script usa:
- `PROJECT_DIR` = cartella del repository corrente
- `PAAS_DIR` = `$HOME/tools/planning-as-a-service/server`

Se vuoi, puoi sovrascrivere i path con variabili ambiente:

```bash
export PROJECT_DIR=/percorso/linux/al/progetto
export PAAS_DIR=/percorso/linux/al/planning-as-a-service/server
npm start
```