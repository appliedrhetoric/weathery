import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as Chart from "chart.js";

Chart.Chart.register(
  Chart.LineController, Chart.BarController, Chart.LineElement, Chart.BarElement,
  Chart.PointElement, Chart.LinearScale, Chart.CategoryScale, Chart.Filler,
  Chart.Tooltip, Chart.Legend
);

// ── Constants ──
const DEFAULT_LAT = 37.7392, DEFAULT_LON = -122.4329, DEFAULT_QUERY = "San Francisco, CA";
const STORAGE_KEY = "nws-dashboard-location";
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const formatDate = d => `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;

const dirLabel = deg => {
  if (deg == null) return "";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
};

function getWeatherIcon(pop, shortForecast, hour) {
  const night = hour < 7 || hour >= 19;
  const sf = (shortForecast || "").toLowerCase();
  if (sf.includes("thunder")) return { icon: "⛈️", label: "Thunderstorms" };
  if (pop >= 60 || sf.includes("rain")) return { icon: "🌧️", label: "Rain" };
  if (pop >= 30 || sf.includes("shower")) return { icon: "🌦️", label: "Showers" };
  if (sf.includes("fog")) return { icon: "🌫️", label: "Fog" };
  if (sf.includes("overcast") || sf.includes("cloudy") && !sf.includes("partly") && !sf.includes("mostly clear"))
    return { icon: "☁️", label: "Overcast" };
  if (sf.includes("partly") || sf.includes("mostly cloudy"))
    return { icon: night ? "🌙" : "⛅", label: "Partly Cloudy" };
  if (sf.includes("mostly clear") || sf.includes("mostly sunny"))
    return { icon: night ? "🌙" : "🌤️", label: "Mostly Clear" };
  if (pop >= 10) return { icon: night ? "🌙" : "⛅", label: "Slight chance rain" };
  return { icon: night ? "🌙" : "☀️", label: "Clear" };
}

const CtoF = c => Math.round(c * 9 / 5 + 32);

// Parse ISO duration like PT1H, PT2H into hours
function parseDuration(iso) {
  const m = iso.match(/PT(\d+)H/);
  return m ? parseInt(m[1]) : 1;
}

// ── Geocoding via Nominatim ──
async function geocodeLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us&addressdetails=1`;
  const res = await fetch(url, { headers: { "User-Agent": "NWS-Weather-Dashboard/1.0" } });
  if (!res.ok) throw new Error("Geocoding failed");
  const results = await res.json();
  if (!results.length) throw new Error(`No results found for "${query}"`);
  const r = results[0];
  // Build a clean location name from address parts
  const addr = r.address || {};
  const city = addr.city || addr.town || addr.village || addr.hamlet || addr.county || "";
  const state = addr.state || "";
  const locationLabel = city && state ? `${city}, ${state}` : city || r.display_name.split(",")[0];
  return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), displayName: locationLabel };
}

// ── Saved location ──
const PREFS_KEY = "nws-dashboard-prefs";

function loadSavedLocation() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return { lat: DEFAULT_LAT, lon: DEFAULT_LON, query: DEFAULT_QUERY, geoLabel: DEFAULT_QUERY };
}

function saveLocation(lat, lon, query, geoLabel) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat, lon, query, geoLabel })); } catch (e) {}
}

function loadPrefs() {
  try {
    const saved = localStorage.getItem(PREFS_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return null;
}

function savePrefs(metrics, selectedDayDate) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      metrics: Array.from(metrics),
      selectedDayDate, // ISO date string like "2026-02-14" or null for week mode
    }));
  } catch (e) {}
}

// ── Data fetching & parsing ──
async function fetchWeatherData(lat, lon) {
  const headers = { "Accept": "application/geo+json", "User-Agent": "(NWS Weather Dashboard, contact@example.com)" };

  // Step 1: Get grid info
  const pointsRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers });
  if (!pointsRes.ok) throw new Error(`Points API error: ${pointsRes.status}`);
  const pointsData = await pointsRes.json();
  const props = pointsData.properties;
  const { gridId, gridX, gridY } = props;

  // Step 2: Fetch hourly forecast (has temp, dewpoint, humidity, wind, pop, shortForecast)
  const hourlyRes = await fetch(props.forecastHourly, { headers });
  if (!hourlyRes.ok) throw new Error(`Hourly API error: ${hourlyRes.status}`);
  const hourlyData = await hourlyRes.json();

  // Step 3: Fetch raw grid data (has cloud cover, QPF, wind gusts)
  const gridRes = await fetch(`https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}`, { headers });
  if (!gridRes.ok) throw new Error(`Grid API error: ${gridRes.status}`);
  const gridData = await gridRes.json();

  // Parse hourly periods
  const periods = hourlyData.properties.periods.map(p => {
    const d = new Date(p.startTime);
    return {
      date: d,
      hour: d.getHours(),
      temp: p.temperature,
      tempUnit: p.temperatureUnit,
      dewpt: p.dewpoint ? Math.round(p.dewpoint.value * 9 / 5 + 32) : null,
      humidity: p.relativeHumidity ? p.relativeHumidity.value : null,
      pop: p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : 0,
      windSpeed: parseInt(p.windSpeed) || 0,
      windDir: p.windDirection,
      shortForecast: p.shortForecast,
      icon: getWeatherIcon(
        p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : 0,
        p.shortForecast,
        d.getHours()
      ),
    };
  });

  // Parse grid data for cloud cover & QPF — expand merged time ranges
  // expandMode: "spread" divides the value across hours (for accumulations like QPF),
  //             "fill" repeats the same value each hour (for instantaneous values like cloud cover)
  const expandGridSeries = (series, converter, expandMode = "fill") => {
    if (!series || !series.values) return {};
    const map = {};
    series.values.forEach(v => {
      const [timeStr, durStr] = v.validTime.split("/");
      const start = new Date(timeStr);
      const hours = parseDuration(durStr);
      const rawVal = converter ? converter(v.value) : v.value;
      const val = expandMode === "spread" ? rawVal / hours : rawVal;
      for (let h = 0; h < hours; h++) {
        const t = new Date(start.getTime() + h * 3600000);
        map[t.toISOString()] = val;
      }
    });
    return map;
  };

  const gp = gridData.properties;
  const cloudMap = expandGridSeries(gp.skyCover, v => Math.round(v), "fill");
  const qpfMap = expandGridSeries(gp.quantitativePrecipitation, v => Math.round(v * 100) / 100, "spread"); // mm, spread across interval
  const gustMap = expandGridSeries(gp.windGust, v => Math.round(v * 0.621371), "fill"); // km/h to mph

  // Merge grid data into periods
  periods.forEach(p => {
    const key = p.date.toISOString();
    p.cloud = cloudMap[key] ?? null;
    p.qpf = qpfMap[key] != null ? Math.round(qpfMap[key] / 25.4 * 1000) / 1000 : 0; // mm to inches
    p.gust = gustMap[key] ?? null;
  });

  return { periods, location: pointsData.properties.relativeLocation.properties, lat, lon };
}

// ── Metric definitions ──
const METRIC_DEFS = {
  temp: {
    label: "Temperature",
    color: "#e8524a",
    unit: "°F",
    axisLabel: "°F",
    getVal: h => h.temp,
    subSeries: [
      { key: "dewpt", label: "Dew Point", color: "#4a9de8", dash: [4, 3], getVal: h => h.dewpt },
    ],
  },
  precip: {
    label: "Precipitation",
    color: "#3b82f6",
    unit: "in",
    axisLabel: "inches",
    chartType: "bar",
    getVal: h => h.qpf || 0,
    // Opacity of each bar is derived from probability of precipitation
    getBarColors: (hours) => hours.map(h => {
      const pop = (h.pop ?? 0) / 100;
      // Map pop to opacity: min 0.15 (so bars are always visible), max 0.9
      const alpha = 0.15 + pop * 0.75;
      return `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
    }),
    getBarBorders: (hours) => hours.map(h => {
      const pop = (h.pop ?? 0) / 100;
      const alpha = 0.3 + pop * 0.7;
      return `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
    }),
    subSeries: [],
    customTooltip: (h) => `${(h.qpf || 0).toFixed(3)} in  (${h.pop ?? 0}% chance)`,
  },
  wind: {
    label: "Wind",
    color: "#10b981",
    unit: "mph",
    axisLabel: "mph",
    getVal: h => h.windSpeed,
    subSeries: [
      { key: "gust", label: "Gusts", color: "#34d399", dash: [4, 3], getVal: h => h.gust },
    ],
  },
  humidity: {
    label: "Humidity",
    color: "#8b5cf6",
    unit: "%",
    axisLabel: "%",
    getVal: h => h.humidity,
    subSeries: [
      { key: "cloud", label: "Cloud Cover", color: "#94a3b8", dash: [4, 3], getVal: h => h.cloud },
    ],
  },
};

// ── Chart component ──
function ChartCanvas({ config }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (chartRef.current) chartRef.current.destroy();
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    chartRef.current = new Chart.Chart(ctx, config);
    return () => { if (chartRef.current) chartRef.current.destroy(); };
  }, [JSON.stringify(config)]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "260px" }} />;
}

// ── Radar/Satellite Panel ──
function RadarPanel({ lat, lon }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const [apiData, setApiData] = useState(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [leafletReady, setLeafletReady] = useState(false);
  const layerRef = useRef(null);
  const intervalRef = useRef(null);

  // Load Leaflet CSS + JS dynamically
  useEffect(() => {
    if (window.L) { setLeafletReady(true); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => setLeafletReady(true);
    document.head.appendChild(script);
  }, []);

  // Initialize map
  useEffect(() => {
    if (!leafletReady || !mapRef.current || mapInstanceRef.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, {
      center: [lat, lon],
      zoom: 7,
      maxZoom: 7,
      zoomControl: true,
      attributionControl: false,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 7,
    }).addTo(map);
    mapInstanceRef.current = map;
    return () => { map.remove(); mapInstanceRef.current = null; };
  }, [leafletReady, lat, lon]);

  // Recenter map when location changes
  useEffect(() => {
    if (mapInstanceRef.current) mapInstanceRef.current.setView([lat, lon], 7);
  }, [lat, lon]);

  // Fetch RainViewer API data
  useEffect(() => {
    const load = () => {
      fetch("https://api.rainviewer.com/public/weather-maps.json")
        .then(r => r.json())
        .then(d => setApiData(d))
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(iv);
  }, []);

  // Get radar frames
  const frames = useMemo(() => {
    if (!apiData || !apiData.radar) return [];
    return [...(apiData.radar.past || []), ...(apiData.radar.nowcast || [])];
  }, [apiData]);

  const lastPastIdx = useMemo(() => {
    if (!apiData || !apiData.radar?.past) return frames.length - 1;
    return apiData.radar.past.length - 1;
  }, [apiData, frames]);

  // Reset frame index when frames change
  useEffect(() => {
    if (frames.length) setFrameIdx(Math.max(0, lastPastIdx));
  }, [frames.length, lastPastIdx]);

  // Display current frame on map
  useEffect(() => {
    if (!leafletReady || !mapInstanceRef.current || !apiData || !frames.length) return;
    const L = window.L;
    const map = mapInstanceRef.current;
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }

    const frame = frames[frameIdx];
    if (!frame) return;

    // Radar tile options
    const colorScheme = 2; // Universal Blue
    const smooth = 1;
    const snow = 1;
    const tileSize = 256;

    const url = `${apiData.host}${frame.path}/${tileSize}/{z}/{x}/{y}/${colorScheme}/${smooth}_${snow}.png`;
    layerRef.current = L.tileLayer(url, { opacity: 0.7, zIndex: 10, maxZoom: 7 }).addTo(map);
  }, [leafletReady, apiData, frames, frameIdx]);

  // Animation loop
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!playing || frames.length < 2) return;
    intervalRef.current = setInterval(() => {
      setFrameIdx(prev => {
        const next = prev + 1;
        // Pause briefly at the last past frame, then continue
        return next >= frames.length ? 0 : next;
      });
    }, 500);
    return () => clearInterval(intervalRef.current);
  }, [playing, frames.length]);

  const currentFrame = frames[frameIdx];
  const timeStr = currentFrame
    ? new Date(currentFrame.time * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    : "";
  const isForecast = frameIdx > lastPastIdx;

  return (
    <div style={{
      background: "rgba(30,41,59,0.5)", borderRadius: 12,
      border: "1px solid rgba(148,163,184,0.1)", overflow: "hidden",
    }}>
      {/* Header row */}
      <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid rgba(148,163,184,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#e2e8f0" }}>
          Precipitation Radar
        </h3>
      </div>

      {/* Map */}
      <div ref={mapRef} className="nws-radar-map" style={{ width: "100%", height: 320, background: "#0f172a" }} />

      {/* Controls */}
      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={() => setPlaying(p => !p)} style={{
          width: 32, height: 32, borderRadius: "50%", border: "1px solid rgba(148,163,184,0.2)",
          background: "rgba(30,41,59,0.8)", color: "#e2e8f0", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
          fontFamily: "inherit",
        }}>
          {playing ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={frameIdx}
          onChange={e => { setPlaying(false); setFrameIdx(parseInt(e.target.value)); }}
          style={{ flex: 1, accentColor: "#3b82f6", minWidth: 100 }}
        />
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500, whiteSpace: "nowrap" }}>
          {timeStr}
          {isForecast && <span style={{ color: "#f59e0b", marginLeft: 6, fontSize: 10, fontWeight: 600 }}>FORECAST</span>}
        </span>
      </div>

      <div style={{ padding: "0 16px 10px", fontSize: 10, color: "#475569" }}>
        Data: RainViewer.com
      </div>
    </div>
  );
}

// ── Main ──
export default function WeatherDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState(null);

  // Restore saved prefs
  const savedPrefs = useRef(loadPrefs());
  const [activeMetrics, setActiveMetrics] = useState(() => {
    const p = savedPrefs.current;
    if (p && p.metrics && p.metrics.length) return new Set(p.metrics);
    return new Set(["temp"]);
  });
  const savedDayDate = useRef(savedPrefs.current?.selectedDayDate || null);

  const saved = useRef(loadSavedLocation());
  const [searchInput, setSearchInput] = useState(saved.current.query);
  const [currentQuery, setCurrentQuery] = useState(saved.current.query);

  // Resolve saved day index once data loads
  const resolveSavedDay = useCallback((periods) => {
    const target = savedDayDate.current;
    if (!target) return null;
    // Find which day index matches the saved date
    const daySet = [];
    const seen = new Set();
    periods.forEach(h => {
      const key = `${h.date.getFullYear()}-${String(h.date.getMonth()+1).padStart(2,'0')}-${String(h.date.getDate()).padStart(2,'0')}`;
      if (!seen.has(key)) { seen.add(key); daySet.push(key); }
    });
    const idx = daySet.indexOf(target);
    return idx >= 0 ? idx : null; // fall back to week mode if day no longer available
  }, []);

  const loadForecast = useCallback(async (lat, lon, query, geoLabel, isAutoRefresh) => {
    if (!isAutoRefresh) {
      setLoading(true);
      setError(null);
      setData(null);
    }
    try {
      const d = await fetchWeatherData(lat, lon);
      if (geoLabel) d.geoLabel = geoLabel;
      setData(d);
      setCurrentQuery(query);
      saveLocation(lat, lon, query, geoLabel);
      // Restore day selection on initial load (not auto-refresh)
      if (!isAutoRefresh && savedDayDate.current) {
        const idx = resolveSavedDay(d.periods);
        setSelectedDay(idx);
      }
    } catch (e) {
      if (!isAutoRefresh) setError(e.message);
      // On auto-refresh failure, silently keep existing data
    }
    if (!isAutoRefresh) setLoading(false);
  }, [resolveSavedDay]);

  const handleSearch = useCallback(async () => {
    const q = searchInput.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedDay(null);
    savedDayDate.current = null;
    try {
      const geo = await geocodeLocation(q);
      const d = await fetchWeatherData(geo.lat, geo.lon);
      d.geoLabel = geo.displayName;
      setData(d);
      setCurrentQuery(q);
      saveLocation(geo.lat, geo.lon, q, geo.displayName);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [searchInput]);

  // Initial load
  useEffect(() => {
    const s = saved.current;
    loadForecast(s.lat, s.lon, s.query, s.geoLabel, false);
  }, [loadForecast]);

  // Auto-refresh every hour
  useEffect(() => {
    const interval = setInterval(() => {
      const s = loadSavedLocation();
      loadForecast(s.lat, s.lon, s.query, s.geoLabel, true);
    }, 60 * 60 * 1000); // 1 hour
    return () => clearInterval(interval);
  }, [loadForecast]);

  const toggleMetric = useCallback((key) => {
    setActiveMetrics(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      // Persist
      const dayDate = savedDayDate.current;
      savePrefs(next, dayDate);
      return next;
    });
  }, []);

  // Wrapper to persist day selection
  const selectDay = useCallback((dayIndex, daysArr) => {
    setSelectedDay(dayIndex);
    let dayDate = null;
    if (dayIndex !== null && daysArr && daysArr[dayIndex]) {
      const d = daysArr[dayIndex].date;
      dayDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    savedDayDate.current = dayDate;
    savePrefs(activeMetrics, dayDate);
  }, [activeMetrics]);

  const { days, viewHours } = useMemo(() => {
    if (!data) return { days: [], viewHours: [] };
    const dayMap = {};
    data.periods.forEach(h => {
      const key = `${h.date.getFullYear()}-${h.date.getMonth()}-${h.date.getDate()}`;
      if (!dayMap[key]) dayMap[key] = { date: new Date(h.date.getFullYear(), h.date.getMonth(), h.date.getDate()), hours: [] };
      dayMap[key].hours.push(h);
    });
    const days = Object.values(dayMap).sort((a, b) => a.date - b.date);
    days.forEach(d => {
      const temps = d.hours.map(h => h.temp);
      const pops = d.hours.map(h => h.pop ?? 0);
      d.hi = Math.max(...temps);
      d.lo = Math.min(...temps);
      d.maxPop = Math.max(...pops);
      d.totalQpf = d.hours.reduce((s, h) => s + (h.qpf || 0), 0);
      const mid = d.hours.find(h => h.hour === 12) || d.hours[Math.floor(d.hours.length / 2)];
      d.icon = mid.icon;
    });
    const viewHours = selectedDay !== null ? days[selectedDay]?.hours || [] : data.periods;
    return { days, viewHours };
  }, [data, selectedDay]);

  // Build chart config with layered axes
  const chartConfig = useMemo(() => {
    if (!viewHours.length) return null;

    const isWeekMode = selectedDay === null;

    const labels = viewHours.map((h, i) => {
      if (!isWeekMode) {
        return h.hour === 0 ? "12a" : h.hour < 12 ? `${h.hour}a` : h.hour === 12 ? "12p" : `${h.hour - 12}p`;
      }
      if (h.hour === 0) return `${DAY_NAMES[h.date.getDay()]} ${h.date.getDate()}`;
      if (h.hour === 12) return "noon";
      return "";
    });

    // In week mode, build per-tick grid line colors: bold at midnight, subtle at noon, invisible otherwise
    const gridColors = isWeekMode ? viewHours.map(h => {
      if (h.hour === 0) return "rgba(148,163,184,0.25)";
      if (h.hour === 12) return "rgba(148,163,184,0.08)";
      return "transparent";
    }) : undefined;

    const tickColors = isWeekMode ? viewHours.map(h => {
      if (h.hour === 0) return "#94a3b8";
      if (h.hour === 12) return "#475569";
      return "transparent";
    }) : undefined;

    const activeList = Array.from(activeMetrics);
    const datasets = [];
    const scales = {
      x: {
        grid: isWeekMode
          ? { color: gridColors, lineWidth: viewHours.map(h => h.hour === 0 ? 1.5 : 1) }
          : { color: "rgba(148,163,184,0.08)" },
        ticks: isWeekMode
          ? {
              color: tickColors,
              font: (ctx) => {
                const h = viewHours[ctx.index];
                return {
                  size: h && h.hour === 0 ? 11 : 9,
                  family: "'DM Sans', sans-serif",
                  weight: h && h.hour === 0 ? "600" : "400",
                };
              },
              maxRotation: 0,
              autoSkip: false,
              callback: (val, idx) => {
                const h = viewHours[idx];
                if (!h) return "";
                if (h.hour === 0) return `${DAY_NAMES[h.date.getDay()]} ${h.date.getDate()}`;
                if (h.hour === 12) return "noon";
                return "";
              },
            }
          : { color: "#64748b", font: { size: 10, family: "'DM Sans', sans-serif" }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
      },
    };

    activeList.forEach((key, idx) => {
      const def = METRIC_DEFS[key];
      const yId = `y_${key}`;
      const position = idx % 2 === 0 ? "left" : "right";

      if (def.chartType === "bar") {
        datasets.push({
          type: "bar",
          label: def.label,
          data: viewHours.map(h => def.getVal(h)),
          backgroundColor: def.getBarColors ? def.getBarColors(viewHours) : def.color + "60",
          borderColor: def.getBarBorders ? def.getBarBorders(viewHours) : def.color,
          borderWidth: 1,
          borderRadius: 2,
          yAxisID: yId,
        });
      } else {
        datasets.push({
          label: def.label,
          data: viewHours.map(h => def.getVal(h)),
          borderColor: def.color,
          backgroundColor: def.color + "18",
          fill: activeList.length === 1,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: yId,
        });
      }

      def.subSeries.forEach(sub => {
        datasets.push({
          label: sub.label,
          data: viewHours.map(h => sub.getVal(h)),
          borderColor: sub.color,
          backgroundColor: sub.color + "10",
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: sub.dash || [],
          yAxisID: yId,
        });
      });

      scales[yId] = {
        type: "linear",
        position,
        beginAtZero: def.chartType === "bar",
        grid: { color: idx === 0 ? "rgba(148,163,184,0.08)" : "transparent" },
        ticks: { color: def.color, font: { size: 10, family: "'DM Sans', sans-serif" } },
        title: { display: true, text: def.axisLabel, color: def.color, font: { size: 11, family: "'DM Sans', sans-serif", weight: "600" } },
      };
    });

    return {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top", labels: { color: "#94a3b8", font: { size: 11, family: "'DM Sans', sans-serif" }, boxWidth: 14, padding: 16, usePointStyle: true } },
          tooltip: {
            backgroundColor: "rgba(15,23,42,0.95)",
            titleFont: { family: "'DM Sans', sans-serif", size: 12 },
            bodyFont: { family: "'DM Sans', sans-serif", size: 11 },
            padding: 12,
            cornerRadius: 8,
            callbacks: {
              title: items => {
                const idx = items[0].dataIndex;
                const h = viewHours[idx];
                const ampm = h.hour < 12 ? "AM" : "PM";
                const hr12 = h.hour === 0 ? 12 : h.hour > 12 ? h.hour - 12 : h.hour;
                return `${formatDate(h.date)} ${hr12}:00 ${ampm}`;
              },
              label: item => {
                const h = viewHours[item.dataIndex];
                if (item.dataset.label === "Precipitation") {
                  return `  Rain: ${(h.qpf || 0).toFixed(3)} in (${h.pop ?? 0}% chance)`;
                }
                return `  ${item.dataset.label}: ${item.formattedValue}`;
              },
            },
          },
        },
        scales,
      },
    };
  }, [viewHours, activeMetrics, selectedDay]);

  // ── Search bar component (reused across states) ──
  const searchBar = (
    <div style={{ maxWidth: 980, margin: "0 auto 24px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleSearch(); }}
          placeholder="City, State or ZIP code..."
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 8,
            border: "1.5px solid rgba(148,163,184,0.2)",
            background: "rgba(15,23,42,0.6)", color: "#e2e8f0",
            fontSize: 14, fontFamily: "inherit", outline: "none",
            transition: "border-color 0.15s",
          }}
          onFocus={e => e.target.style.borderColor = "rgba(59,130,246,0.5)"}
          onBlur={e => e.target.style.borderColor = "rgba(148,163,184,0.2)"}
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          style={{
            padding: "10px 20px", borderRadius: 8, border: "none",
            background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 600,
            fontFamily: "inherit", cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.6 : 1, transition: "opacity 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          {loading ? "Loading..." : "Get Forecast"}
        </button>
      </div>
    </div>
  );

  // ── Render ──
  if (loading) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "linear-gradient(145deg, #0f172a 0%, #1e293b 100%)", color: "#e2e8f0", minHeight: "100vh", padding: "24px 20px" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        {searchBar}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, marginTop: 80 }}>
          <div style={{ width: 36, height: 36, border: "3px solid #334155", borderTopColor: "#60a5fa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ color: "#94a3b8", fontSize: 14 }}>Fetching forecast from NWS...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ fontFamily: "'DM Sans', system-ui, sans-serif", background: "linear-gradient(145deg, #0f172a 0%, #1e293b 100%)", color: "#e2e8f0", minHeight: "100vh", padding: "24px 20px" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        {searchBar}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, marginTop: 60 }}>
          <div style={{ fontSize: 32 }}>⚠️</div>
          <p style={{ color: "#f87171", fontSize: 15, fontWeight: 600 }}>Failed to load forecast</p>
          <p style={{ color: "#94a3b8", fontSize: 13, maxWidth: 400, textAlign: "center" }}>{error}</p>
          <p style={{ color: "#64748b", fontSize: 12, maxWidth: 400, textAlign: "center" }}>
            Note: NWS only covers US locations. Try a US city, state, or ZIP code.
          </p>
        </div>
      </div>
    );
  }

  const allTemps = data.periods.map(h => h.temp);
  const allPops = data.periods.map(h => h.pop ?? 0);
  const allQpf = data.periods.reduce((s, h) => s + (h.qpf || 0), 0);
  const locationName = data.geoLabel || (data.location ? `${data.location.city}, ${data.location.state}` : currentQuery);

  return (
    <div style={{
      fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
      background: "linear-gradient(145deg, #0f172a 0%, #1e293b 100%)",
      color: "#e2e8f0",
      minHeight: "100vh",
      padding: "24px 20px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`
        .nws-wrap { max-width: 980px; margin-left: auto; margin-right: auto; }
        .nws-header-title { font-size: 26px; }
        .nws-header-coords { font-size: 13px; }
        .nws-day-cards { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
        .nws-day-btn { flex: 0 0 auto; min-width: 100px; padding: 10px 14px; }
        .nws-day-icon { font-size: 28px; line-height: 1; margin-bottom: 4px; }
        .nws-day-temp { font-size: 13px; }
        .nws-metric-btns { display: flex; gap: 6px; flex-wrap: wrap; }
        .nws-metric-btn { padding: 7px 16px; font-size: 12px; }
        .nws-chart-wrap { height: 260px; }
        .nws-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
        .nws-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .nws-table { font-size: 12px; }
        .nws-table td, .nws-table th { padding: 6px 8px; }
        .nws-detail-card { display: none; }

        @media (max-width: 640px) {
          .nws-header-title { font-size: 20px; }
          .nws-header-coords { font-size: 11px; display: block; margin-top: 2px; }
          .nws-day-cards { gap: 6px; margin-left: -8px; margin-right: -8px; padding-left: 8px; padding-right: 8px; }
          .nws-day-btn { min-width: 72px; padding: 8px 8px; }
          .nws-day-icon { font-size: 22px; }
          .nws-day-temp { font-size: 12px; }
          .nws-day-label-dow { font-size: 10px !important; }
          .nws-day-label-date { font-size: 11px !important; margin-bottom: 3px !important; }
          .nws-day-pop { font-size: 10px !important; }
          .nws-alldays-btn { padding: 8px 12px !important; font-size: 11px !important; }
          .nws-metric-btns { gap: 4px; }
          .nws-metric-btn { padding: 6px 12px; font-size: 11px; }
          .nws-chart-wrap { height: 200px; }
          .nws-stats-grid { grid-template-columns: repeat(2, 1fr); gap: 6px; }
          .nws-stat-box { padding: 10px 12px !important; }
          .nws-stat-label { font-size: 10px !important; }
          .nws-stat-value { font-size: 14px !important; }
          .nws-table { display: none; }
          .nws-detail-card { display: block; }
          .nws-radar-map { height: 240px !important; }
        }
      `}</style>

      {/* Search bar */}
      {searchBar}

      {/* Header */}
      <div className="nws-wrap" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
          <h1 className="nws-header-title" style={{ fontWeight: 700, margin: 0, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
            {locationName}
          </h1>
          <span className="nws-header-coords" style={{ color: "#64748b", fontWeight: 500 }}>{data.lat.toFixed(4)}°N {Math.abs(data.lon).toFixed(4)}°W</span>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
          NWS Hourly Forecast — Live from api.weather.gov
        </p>
      </div>

      {/* Day cards */}
      <div className="nws-wrap" style={{ marginBottom: 20 }}>
        <div className="nws-day-cards">
          <button className="nws-alldays-btn" onClick={() => selectDay(null, days)} style={{
            flex: "0 0 auto", padding: "12px 16px", borderRadius: 10,
            border: selectedDay === null ? "1.5px solid rgba(59,130,246,0.5)" : "1.5px solid rgba(148,163,184,0.12)",
            background: selectedDay === null ? "rgba(59,130,246,0.1)" : "rgba(30,41,59,0.6)",
            color: selectedDay === null ? "#93c5fd" : "#94a3b8",
            cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap", transition: "all 0.15s",
          }}>All Days</button>
          {days.map((d, i) => (
            <button key={i} className="nws-day-btn" onClick={() => selectDay(i, days)} style={{
              borderRadius: 10,
              border: selectedDay === i ? "1.5px solid rgba(59,130,246,0.5)" : "1.5px solid rgba(148,163,184,0.12)",
              background: selectedDay === i ? "rgba(59,130,246,0.1)" : "rgba(30,41,59,0.6)",
              cursor: "pointer", fontFamily: "inherit", textAlign: "center", transition: "all 0.15s",
            }}>
              <div className="nws-day-label-dow" style={{ fontSize: 11, fontWeight: 500, color: selectedDay === i ? "#93c5fd" : "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>{DAY_NAMES[d.date.getDay()]}</div>
              <div className="nws-day-label-date" style={{ fontSize: 13, fontWeight: 700, color: selectedDay === i ? "#e0e7ff" : "#cbd5e1", marginBottom: 5 }}>{MONTH_NAMES[d.date.getMonth()]} {d.date.getDate()}</div>
              <div className="nws-day-icon">{d.icon.icon}</div>
              <div className="nws-day-temp" style={{ fontWeight: 600, color: "#f1f5f9" }}>{d.hi}° <span style={{ color: "#64748b", fontWeight: 400 }}>{d.lo}°</span></div>
              {d.maxPop > 10 && <div className="nws-day-pop" style={{ fontSize: 11, color: "#60a5fa", marginTop: 3 }}>💧 {d.maxPop}%</div>}
            </button>
          ))}
        </div>
      </div>

      {/* Metric toggles */}
      <div className="nws-wrap" style={{ marginBottom: 16 }}>
        <div className="nws-metric-btns">
          {Object.entries(METRIC_DEFS).map(([key, def]) => {
            const active = activeMetrics.has(key);
            return (
              <button key={key} className="nws-metric-btn" onClick={() => toggleMetric(key)} style={{
                borderRadius: 20, border: "none", cursor: "pointer",
                fontWeight: 600, fontFamily: "inherit", transition: "all 0.15s",
                background: active ? def.color : "rgba(30,41,59,0.8)",
                color: active ? "#fff" : "#64748b",
                opacity: active ? 1 : 0.7,
              }}>
                <span style={{ marginRight: 5, fontSize: 11 }}>{active ? "✓" : "○"}</span>
                {def.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Precip opacity legend hint */}
      {activeMetrics.has("precip") && (
        <div className="nws-wrap" style={{ marginTop: -10, marginBottom: 12, display: "flex", alignItems: "center", gap: 8, paddingLeft: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(59,130,246,0.15)" }} />
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(59,130,246,0.45)" }} />
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(59,130,246,0.75)" }} />
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "rgba(59,130,246,0.9)" }} />
          </div>
          <span style={{ fontSize: 11, color: "#64748b" }}>Bar opacity = probability of precipitation</span>
        </div>
      )}

      {/* Chart */}
      <div className="nws-wrap" style={{ marginBottom: 24 }}>
        <div style={{
          background: "rgba(30,41,59,0.5)", borderRadius: 12,
          border: "1px solid rgba(148,163,184,0.1)", padding: "12px 12px 8px",
        }}>
          <div className="nws-chart-wrap">
            {chartConfig && <ChartCanvas config={chartConfig} />}
          </div>
        </div>
      </div>

      {/* Summary stats — context-dependent */}
      <div className="nws-wrap" style={{ marginBottom: 20 }}>
        {(() => {
          const isDay = selectedDay !== null && days[selectedDay];
          const scope = isDay ? days[selectedDay].hours : data.periods;
          const scopeTemps = scope.map(h => h.temp);
          const scopePops = scope.map(h => h.pop ?? 0);
          const scopeQpf = scope.reduce((s, h) => s + (h.qpf || 0), 0);
          const scopeWind = scope.map(h => h.windSpeed);
          const stats = isDay ? [
            { label: formatDate(days[selectedDay].date), value: days[selectedDay].icon.icon + " " + days[selectedDay].icon.label },
            { label: "Hi / Lo", value: `${Math.max(...scopeTemps)}° / ${Math.min(...scopeTemps)}°F` },
            { label: "Peak Rain Chance", value: `${Math.max(...scopePops)}%` },
            { label: "Day Precip Est.", value: `${scopeQpf.toFixed(2)} in` },
            { label: "Wind Range", value: `${Math.min(...scopeWind)}–${Math.max(...scopeWind)} mph` },
          ] : [
            { label: "Forecast Range", value: days.length ? `${formatDate(days[0].date)} – ${formatDate(days[days.length - 1].date)}` : "—" },
            { label: "Temp Range", value: `${Math.min(...scopeTemps)}° – ${Math.max(...scopeTemps)}°F` },
            { label: "Peak Rain Chance", value: `${Math.max(...scopePops)}%` },
            { label: "Total Precip Est.", value: `${scopeQpf.toFixed(2)} in` },
          ];
          return (
            <div className="nws-stats-grid">
              {stats.map((s, i) => (
                <div key={i} className="nws-stat-box" style={{ background: "rgba(30,41,59,0.5)", borderRadius: 10, border: "1px solid rgba(148,163,184,0.08)", padding: "14px 16px" }}>
                  <div className="nws-stat-label" style={{ fontSize: 11, color: "#64748b", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
                  <div className="nws-stat-value" style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>{s.value}</div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Radar/Satellite animation — week mode only */}
      {selectedDay === null && data && (
        <div className="nws-wrap" style={{ marginBottom: 24 }}>
          <RadarPanel lat={data.lat} lon={data.lon} />
        </div>
      )}

      {/* Hourly detail for selected day */}
      {selectedDay !== null && days[selectedDay] && (
        <div className="nws-wrap" style={{ marginBottom: 24 }}>
          <div style={{
            background: "rgba(30,41,59,0.5)", borderRadius: 12,
            border: "1px solid rgba(148,163,184,0.1)", overflow: "hidden",
          }}>
            <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(148,163,184,0.08)" }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#e2e8f0" }}>
                Hourly Detail — {formatDate(days[selectedDay].date)}
              </h3>
            </div>

            {/* Desktop: table */}
            <div className="nws-table-wrap">
              <table className="nws-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "#64748b", fontWeight: 600 }}>
                    {["Hour","","Temp","Dew","RH%","Pop%","Rain","Wind","Gust","Dir","Cloud","Forecast"].map((h, i) => (
                      <th key={i} style={{ padding: "8px 8px", textAlign: i < 2 || i === 11 ? "left" : "center", whiteSpace: "nowrap", borderBottom: "1px solid rgba(148,163,184,0.08)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days[selectedDay].hours.map((h, i) => {
                    const timeStr = h.hour === 0 ? "12 AM" : h.hour < 12 ? `${h.hour} AM` : h.hour === 12 ? "12 PM" : `${h.hour - 12} PM`;
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(148,163,184,0.04)" }}>
                        <td style={{ padding: "6px 8px", color: "#cbd5e1", fontWeight: 500 }}>{timeStr}</td>
                        <td style={{ padding: "6px 4px", fontSize: 18 }}>{h.icon.icon}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#f1f5f9", fontWeight: 600 }}>{h.temp}°</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.dewpt != null ? h.dewpt + "°" : "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.humidity != null ? h.humidity : "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center" }}>
                          <span style={{ color: h.pop >= 60 ? "#60a5fa" : h.pop >= 30 ? "#93c5fd" : "#94a3b8", fontWeight: h.pop >= 30 ? 600 : 400 }}>{h.pop ?? 0}</span>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.qpf > 0 ? h.qpf.toFixed(3) + '"' : "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.windSpeed}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.gust != null ? h.gust : "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.windDir || "—"}</td>
                        <td style={{ padding: "6px 8px", textAlign: "center", color: "#94a3b8" }}>{h.cloud != null ? h.cloud + "%" : "—"}</td>
                        <td style={{ padding: "6px 8px", color: "#94a3b8", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.shortForecast}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: card layout */}
            <div className="nws-detail-card" style={{ padding: "8px" }}>
              {days[selectedDay].hours.map((h, i) => {
                const timeStr = h.hour === 0 ? "12 AM" : h.hour < 12 ? `${h.hour} AM` : h.hour === 12 ? "12 PM" : `${h.hour - 12} PM`;
                return (
                  <div key={i} style={{
                    display: "grid", gridTemplateColumns: "54px 32px 1fr", gap: 6, alignItems: "center",
                    padding: "10px 8px", borderBottom: "1px solid rgba(148,163,184,0.06)",
                  }}>
                    <div style={{ color: "#cbd5e1", fontWeight: 600, fontSize: 13 }}>{timeStr}</div>
                    <div style={{ fontSize: 20 }}>{h.icon.icon}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 12 }}>
                      <span style={{ color: "#f1f5f9", fontWeight: 600 }}>{h.temp}°F</span>
                      {(h.pop ?? 0) > 0 && <span style={{ color: "#60a5fa" }}>💧{h.pop}%</span>}
                      {h.qpf > 0 && <span style={{ color: "#93c5fd" }}>{h.qpf.toFixed(3)}"</span>}
                      <span style={{ color: "#94a3b8" }}>{h.windSpeed}mph {h.windDir || ""}</span>
                      {h.humidity != null && <span style={{ color: "#94a3b8" }}>RH {h.humidity}%</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="nws-wrap" style={{ marginTop: 20, fontSize: 11, color: "#475569", textAlign: "center" }}>
        Data: National Weather Service via api.weather.gov
      </div>
    </div>
  );
}
