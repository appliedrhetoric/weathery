# NWS Weather Dashboard

A responsive, client-side weather dashboard that pulls live hourly forecast data from the [National Weather Service API](https://www.weather.gov/documentation/services-web-api) and precipitation radar from [RainViewer](https://www.rainviewer.com/api.html).

## Features

- **Live NWS data** — hourly temperature, dewpoint, humidity, wind, precipitation probability, quantitative precipitation forecast (QPF), cloud cover, and short forecast text
- **7-day overview** with day tiles showing high/low temps, weather icons, and precipitation chance
- **Layered chart** — toggle Temperature, Precipitation, Wind, and Humidity independently with multi-axis overlay
- **Precipitation bars** — QPF shown as bar height, probability encoded as bar opacity
- **Day detail view** — select any day for an hourly breakdown table (card layout on mobile)
- **Context-sensitive summary stats** — aggregated for the week or the selected day
- **Precipitation radar** — animated RainViewer radar loop with play/pause and scrubber
- **Location search** — enter any US city, state, or ZIP code (geocoded via [Nominatim](https://nominatim.openstreetmap.org/))
- **Persistent state** — last location, selected day, and active metrics survive page refreshes (localStorage)
- **Auto-refresh** — forecast data reloads silently every hour
- **Responsive layout** — adapts for mobile with compact day tiles, smaller chart, and card-based hourly detail
- **Week mode chart clarity** — midnight boundaries marked with bold grid lines and day labels; noon marked subtly

## Data Sources

| Source | What it provides | Auth |
|--------|-----------------|------|
| [api.weather.gov](https://api.weather.gov) | Hourly forecast, grid data (QPF, cloud cover, wind gusts) | None (free, public) |
| [Nominatim / OpenStreetMap](https://nominatim.org) | Geocoding (city/ZIP → lat/lon) | None (free for light use) |
| [RainViewer](https://www.rainviewer.com/api.html) | Precipitation radar tiles | None (free tier, max zoom 7) |
| [Leaflet.js](https://leafletjs.com) | Map rendering for radar panel | Loaded from CDN at runtime |
| [CartoDB](https://carto.com/basemaps) | Dark basemap tiles | None |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm (included with Node.js)

## Setup

```bash
git clone https://github.com/appliedrhetoric/weathery.git
cd weathery
npm install
```

## Development

```bash
npm run dev
```

Opens a local dev server (default: `http://localhost:5173`) with hot reload.

## Production Build

```bash
npm run build
```

Generates static files in `dist/`. These are purely client-side — no server process needed. Point any web server (nginx, Apache, Caddy, etc.) at the `dist/` directory.

To preview the production build locally:

```bash
npm run preview
```

## Deployment

The `dist/` folder contains a self-contained static site. Example nginx configuration:

```nginx
server {
    listen 80;
    server_name weather.example.com;
    root /path/to/weathery/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

All API calls are made client-side from the browser — no backend, proxy, or API keys required.

## Project Structure

```
weathery/
├── index.html          # Vite entry point
├── package.json        # Dependencies and scripts
├── vite.config.js      # Vite configuration
├── README.md
├── .gitignore
└── src/
    ├── main.jsx        # React mount point
    └── App.jsx         # Weather dashboard component
```

## NWS API Notes

- The NWS API occasionally returns 500 errors — a page reload typically resolves this
- NWS coverage is US-only; non-US locations will fail at the `/points` endpoint
- QPF values from `/gridpoints` use merged time intervals (e.g. PT6H); the app spreads accumulated values across individual hours
- No API key or registration is required

## RainViewer Notes

- The free API tier provides past radar data only (no satellite imagery, no nowcast)
- Maximum tile zoom level is 7
- Radar data covers approximately the last 2 hours in 10-minute intervals

## License

MIT
