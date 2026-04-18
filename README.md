# Charlie's Tickers

A sleek, modern dark-themed stock/crypto ticker dashboard.

## Features

- Floating ticker cards for:
  - CoreWeave (`CRWV`), Google (`GOOGL`), Amazon (`AMZN`), Oracle (`ORCL`), Tesla (`TSLA`), Microsoft (`MSFT`), Alibaba (`BABA`), Workday (`WDAY`), Salesforce (`CRM`), Apple (`AAPL`), Nike (`NKE`)
  - BTC (`BTC/USD`), ETH (`ETH/USD`)
  - S&P 500 via `SPY`
- Live quotes via **Twelve Data** (free tier available)
- Updates every **5 seconds** only during **market hours** (9:30am–4:00pm New York time, Mon–Fri)
- Shows a clear “markets closed” message outside hours
- Random scattered background images (dogs, soccer, football) via Unsplash Source (no API key)

## Run locally

1. Start the dev server:

```bash
cd "charlies-tickers"
node server.js
```

2. Open `http://localhost:5173`

3. Click **API Settings** and paste your Twelve Data API key.

## Notes

- The Twelve Data free tier has rate limits. This app uses a **single batch request** per refresh to minimize requests.
- CoreWeave’s symbol is set to `CRWV` (adjust in `app.js` if needed).

