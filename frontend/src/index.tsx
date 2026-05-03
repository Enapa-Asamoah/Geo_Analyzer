import React, { useState, useEffect, useCallback } from "react";
import {
  Download, Map, BarChart3, FileText, Activity,
  ChevronDown, AlertTriangle, CheckCircle, Info,
  Layers, TreePine, RefreshCw, ImageIcon, MapPinned
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Legend
} from "recharts";
import { GeoJSON, MapContainer, TileLayer } from "react-leaflet";

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewType = "rgb" | "pca" | "ndvi" | "district_map" | "map" | "transition" | "summary" | "download";

interface AnalysisResult {
  hotspot: string;
  year_a: number;
  year_b: number;
  rgb: {
    year_a: { year: number; image: string };
    year_b: { year: number; image: string };
  };
  pca: {
    year_a: { year: number; image: string };
    year_b: { year: number; image: string };
  };
  ndvi: {
    year_a: { year: number; image: string; stats: NdviStats };
    year_b: { year: number; image: string; stats: NdviStats };
    loss_map: string;
    significant_loss_pixels: number;
  };
  segmentation: {
    year_a: SegYear;
    year_b: SegYear;
    change_map: string;
    segmented_change: string;
    transition_matrix: { data: number[][]; labels: string[]; k: number };
    major_change_pixels: number;
  };
  risk: {
    risk_score: number;
    risk_score_10: number;
    level: "low" | "moderate" | "high";
    components: { embedding_change: number; ndvi_loss: number; transition_instability: number };
  };
}

interface NdviStats { mean: number; min: number; max: number; positive_pct: number }
interface ClassDist { class_id: number; label: string; count: number; pct: number }
interface SegYear {
  year: number;
  seg_overlay: string;
  seg_map: string;
  distribution: ClassDist[];
  labels: string[];
}

interface DistrictFeature {
  type: "Feature";
  geometry: any;
  properties: {
    district: string;
    region: string;
    hotspot?: string | null;
    has_data: boolean;
    centroid: [number, number];
  };
}

interface DistrictFeatureCollection {
  type: "FeatureCollection";
  features: DistrictFeature[];
  meta: {
    with_data: number;
    without_data: number;
    hotspots: string[];
  };
}

interface DistrictInsight {
  district: string;
  region: string;
  hotspot: string;
  year_a: number;
  year_b: number;
  rgb: {
    year_a: { year: number; image: string };
    year_b: { year: number; image: string };
  };
  pca: {
    year_a: { year: number; image: string };
    year_b: { year: number; image: string };
  };
  risk: {
    risk_score_10: number;
    level: "low" | "moderate" | "high";
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API = "http://localhost:8000";

const HOTSPOTS = [
  "Obuasi","Tarkwa","Prestea","Bibiani","Dunkwa",
  "Konongo","Goaso","Kibi","Winneba","Bekwai",
  "Sefwi-Bekwai","Bui","Bole","Nangodi","Wa","Lawra"
];

const YEARS = [2017,2018,2019,2020,2021,2022,2023,2024];

const CLASS_COLORS = ["#1e3a5f","#8b4513","#c8a96b","#5a8f3c","#1a6b3c"];
const CHANGE_LEVEL_COLORS = ["#d4edda","#fff3cd","#ffe0b2","#f8d7da"];

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function DistrictMapPanel({ yearA, yearB }: { yearA: string; yearB: string }) {
  const [mapData, setMapData] = useState<DistrictFeatureCollection | null>(null);
  const [loadingMap, setLoadingMap] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);

  const yearANum = parseInt(yearA, 10);
  const yearBNum = parseInt(yearB, 10);
  const yearsReady = Number.isInteger(yearANum) && Number.isInteger(yearBNum) && yearANum !== yearBNum;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingMap(true);
      setMapError(null);
      try {
        const url = yearsReady
          ? `${API}/districts/map?year_a=${yearANum}&year_b=${yearBNum}`
          : `${API}/districts/map`;
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`Failed to load district map (HTTP ${resp.status})`);
        }
        const data: DistrictFeatureCollection = await resp.json();
        if (!cancelled) setMapData(data);
      } catch (e: any) {
        if (!cancelled) setMapError(e.message ?? "Failed to load district map.");
      } finally {
        if (!cancelled) setLoadingMap(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [yearANum, yearBNum, yearsReady]);

  const onEachDistrict = useCallback((feature: any, layer: any) => {
    const props = feature?.properties;
    if (!props) return;

    if (!props.has_data) {
      layer.bindPopup(
        `<div style="font-family:DM Sans, sans-serif; min-width:220px;">` +
        `<div style="font-weight:700; color:#1f2937; margin-bottom:4px;">${htmlEscape(props.district)}</div>` +
        `<div style="font-size:12px; color:#6b7280;">Region: ${htmlEscape(props.region || "Unknown")}</div>` +
        `<div style="margin-top:8px; font-size:12px; color:#6b7280; background:#f3f4f6; border-radius:8px; padding:8px;">No RGB/embedding data available for this district yet.</div>` +
        `</div>`
      );
      return;
    }

    layer.on("click", async () => {
      if (!yearsReady) {
        layer.bindPopup(
          `<div style="font-family:DM Sans, sans-serif; min-width:220px;">` +
          `<div style="font-weight:700; color:#1f2937; margin-bottom:4px;">${htmlEscape(props.district)}</div>` +
          `<div style="font-size:12px; color:#6b7280;">Select two different years to load district insights.</div>` +
          `</div>`
        ).openPopup();
        return;
      }

      layer.bindPopup(
        `<div style="font-family:DM Sans, sans-serif; min-width:220px; font-size:12px; color:#6b7280;">Loading RGB, PCA, and risk summary...</div>`
      ).openPopup();

      try {
        const url = `${API}/districts/insight?district=${encodeURIComponent(props.district)}&year_a=${yearANum}&year_b=${yearBNum}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          throw new Error(errBody?.detail ? String(errBody.detail) : `HTTP ${resp.status}`);
        }

        const detail: DistrictInsight = await resp.json();
        const riskColor = detail.risk.level === "high" ? "#ef4444" : detail.risk.level === "moderate" ? "#f59e0b" : "#22c55e";

        const html =
          `<div style="font-family:DM Sans, sans-serif; min-width:280px; max-width:320px;">` +
          `<div style="font-weight:700; font-size:14px; color:#111827;">${htmlEscape(detail.district)}</div>` +
          `<div style="font-size:12px; color:#6b7280; margin-bottom:6px;">${htmlEscape(detail.region)} · Hotspot ${htmlEscape(detail.hotspot)}</div>` +
          `<div style="font-size:12px; margin:6px 0 8px;">` +
            `<span style="display:inline-block; background:${riskColor}; color:white; padding:2px 8px; border-radius:999px; font-weight:700; text-transform:uppercase; font-size:10px;">${htmlEscape(detail.risk.level)}</span>` +
            `<span style="margin-left:8px; color:#111827; font-weight:700;">Risk ${detail.risk.risk_score_10.toFixed(1)} / 10</span>` +
          `</div>` +
          `<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">` +
            `<div>` +
              `<div style="font-size:11px; color:#6b7280; margin-bottom:4px;">RGB ${detail.year_a}</div>` +
              `<img src="data:image/png;base64,${detail.rgb.year_a.image}" style="width:100%; border-radius:6px;" />` +
            `</div>` +
            `<div>` +
              `<div style="font-size:11px; color:#6b7280; margin-bottom:4px;">RGB ${detail.year_b}</div>` +
              `<img src="data:image/png;base64,${detail.rgb.year_b.image}" style="width:100%; border-radius:6px;" />` +
            `</div>` +
            `<div>` +
              `<div style="font-size:11px; color:#6b7280; margin-bottom:4px;">PCA ${detail.year_a}</div>` +
              `<img src="data:image/png;base64,${detail.pca.year_a.image}" style="width:100%; border-radius:6px;" />` +
            `</div>` +
            `<div>` +
              `<div style="font-size:11px; color:#6b7280; margin-bottom:4px;">PCA ${detail.year_b}</div>` +
              `<img src="data:image/png;base64,${detail.pca.year_b.image}" style="width:100%; border-radius:6px;" />` +
            `</div>` +
          `</div>` +
          `</div>`;

        layer.setPopupContent(html).openPopup();
      } catch (e: any) {
        layer.setPopupContent(
          `<div style="font-family:DM Sans, sans-serif; min-width:220px; color:#b91c1c; font-size:12px;">Failed to load district details: ${htmlEscape(e.message ?? "Unknown error")}</div>`
        ).openPopup();
      }
    });

    layer.bindPopup(
      `<div style="font-family:DM Sans, sans-serif; min-width:220px;">` +
      `<div style="font-weight:700; color:#1f2937; margin-bottom:4px;">${htmlEscape(props.district)}</div>` +
      `<div style="font-size:12px; color:#6b7280;">Region: ${htmlEscape(props.region || "Unknown")}</div>` +
      `<div style="margin-top:8px; font-size:12px; color:#065f46;">Click to view RGB, PCA, and risk summary.</div>` +
      `</div>`
    );
  }, [yearANum, yearBNum, yearsReady]);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <SectionHeader
        title="District Explorer Map"
        subtitle="Grey districts have no available imagery. Click a coloured district to open RGB, PCA embedding, and risk popup."
      />

      <div className="mb-3 text-xs text-gray-500 flex flex-wrap gap-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" /> Data available
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-gray-300 inline-block" /> No data
        </span>
        <span>Year A: {yearA || "-"} · Year B: {yearB || "-"}</span>
      </div>

      {loadingMap && <Spinner label="Loading district boundaries..." />}
      {!loadingMap && mapError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-4 py-3">
          {mapError}
        </div>
      )}

      {!loadingMap && !mapError && mapData && (
        <>
          <div className="h-[620px] rounded-xl overflow-hidden border border-gray-100">
            <MapContainer
              center={[7.9465, -1.0232]}
              zoom={7}
              style={{ height: "100%", width: "100%" }}
              scrollWheelZoom
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <GeoJSON
                data={mapData as any}
                style={(feature: any) => ({
                  color: "#ffffff",
                  weight: 1,
                  fillColor: feature?.properties?.has_data ? "#0f766e" : "#c7ccd1",
                  fillOpacity: feature?.properties?.has_data ? 0.72 : 0.78,
                })}
                onEachFeature={onEachDistrict}
              />
            </MapContainer>
          </div>

          <div className="mt-3 text-xs text-gray-500">
            {mapData.meta.with_data} districts mapped to available hotspots · {mapData.meta.without_data} districts currently greyed out.
          </div>
        </>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function B64Image({ b64, alt, className = "" }: { b64: string; alt: string; className?: string }) {
  return (
    <img
      src={`data:image/png;base64,${b64}`}
      alt={alt}
      className={`rounded-lg w-full object-cover ${className}`}
    />
  );
}

function ImageCard({ b64, label, subtitle }: { b64: string; label: string; subtitle?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <B64Image b64={b64} alt={label} />
      <div>
        <div className="text-xs font-semibold text-gray-700">{label}</div>
        {subtitle && <div className="text-xs text-gray-400">{subtitle}</div>}
      </div>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5 pb-4 border-b border-gray-100">
      <h3 className="text-base font-bold text-gray-800">{title}</h3>
      {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-4 border border-gray-100">
      <div className={`text-xl font-bold ${accent ?? "text-gray-800"}`}>{value}</div>
      <div className="text-xs font-medium text-gray-600 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

// Risk gauge SVG
function RiskGauge({ score, level }: { score: number; level: string }) {
  const pct = Math.min(1, Math.max(0, score));
  const color = level === "high" ? "#ef4444" : level === "moderate" ? "#f59e0b" : "#22c55e";
  const angle = -135 + pct * 270;
  const cos = Math.cos((angle - 90) * Math.PI / 180);
  const sin = Math.sin((angle - 90) * Math.PI / 180);
  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="82" viewBox="0 0 120 82">
        <path d="M12 70 A48 48 0 0 1 108 70" fill="none" stroke="#e5e7eb" strokeWidth="10" strokeLinecap="round" />
        <path
          d="M12 70 A48 48 0 0 1 108 70"
          fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${pct * 150.8} 150.8`}
        />
        <line x1="60" y1="70" x2={60 + 34 * cos} y2={70 + 34 * sin}
          stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="60" cy="70" r="4" fill={color} />
        <text x="60" y="56" textAnchor="middle" fontSize="7" fill="#9ca3af">LOW</text>
        <text x="16" y="78" textAnchor="middle" fontSize="6" fill="#9ca3af">0</text>
        <text x="104" y="78" textAnchor="middle" fontSize="6" fill="#9ca3af">10</text>
      </svg>
      <div className="text-2xl font-black mt-0" style={{ color }}>{(score * 10).toFixed(1)}</div>
      <div className="text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">{level} risk</div>
    </div>
  );
}

// Transition matrix heatmap
function TransitionMatrix({ data, labels, yearA, yearB }: {
  data: number[][];
  labels: string[];
  yearA: number;
  yearB: number;
}) {
  const maxVal = Math.max(...data.flat(), 1);
  const totalPixels = Math.max(data.flat().reduce((sum, v) => sum + v, 0), 1);
  const shortLabel = (l: string) => l.split(" ")[0];

  return (
    <div>
      <div className="text-xs text-gray-400 mb-3">
        Rows = <strong>{yearA}</strong> classes → Columns = <strong>{yearB}</strong> classes.
        Cells show <strong>% of total pixels</strong>. Diagonal (green) = stable. Off-diagonal (blue) = transitions.
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="p-1.5 text-gray-300 font-normal text-left pr-3 text-[10px]">
                {yearA} ↓ / {yearB} →
              </th>
              {labels.map((l, j) => (
                <th key={j} className="p-1.5 text-gray-500 font-semibold text-center min-w-[80px] text-[10px]">
                  {shortLabel(l)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i}>
                <td className="p-1.5 font-semibold text-gray-600 text-[10px] pr-3 whitespace-nowrap">
                  {shortLabel(labels[i] ?? `C${i}`)}
                </td>
                {row.map((val, j) => {
                  const t = val / maxVal;
                  const pct = (val / totalPixels) * 100;
                  const pctText = pct < 0.1 && val > 0 ? '<0.1%' : `${pct.toFixed(1)}%`;
                  const isDiag = i === j;
                  const bg = isDiag
                    ? `rgba(34,197,94,${0.1 + t * 0.75})`
                    : `rgba(59,130,246,${t * 0.7})`;
                  const textC = t > 0.55 ? "white" : "#374151";
                  return (
                    <td key={j} className="p-0.5 text-center">
                      <div
                        className="h-9 w-full flex flex-col items-center justify-center rounded text-[10px] font-medium"
                        style={{ background: bg, color: textC, minWidth: 72 }}
                        title={`${val.toLocaleString()} pixels (${pct.toFixed(2)}%)`}
                      >
                        <span>{pctText}</span>
                        <span className="text-[9px] opacity-70">{val.toLocaleString()} px</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-4 mt-3 text-[10px] text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded" style={{ background: "rgba(34,197,94,0.65)", display: "inline-block" }} />
          Stable (same class)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded" style={{ background: "rgba(59,130,246,0.5)", display: "inline-block" }} />
          Class transition
        </span>
      </div>
    </div>
  );
}

// Class distribution bar chart
function ClassDistChart({ dist, title }: { dist: ClassDist[]; title: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-600 mb-3">{title}</div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={dist} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9 }} tickFormatter={l => l.split(" ")[0]} />
          <YAxis tick={{ fontSize: 9 }} />
          <Tooltip
            formatter={(v, _n, p: any) => {
              const raw = Array.isArray(v) ? v[0] : v;
              const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
              return [`${p.payload.pct}% (${count.toLocaleString()} px)`, p.payload.label];
            }}
            labelFormatter={() => ""}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {dist.map((_, i) => (
              <Cell key={i} fill={CLASS_COLORS[i % CLASS_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Loading spinner
function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
      <p className="text-sm text-gray-400">{label ?? "Running analysis…"}</p>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [location, setLocation] = useState("");
  const [year1, setYear1] = useState<string>("");
  const [year2, setYear2] = useState<string>("");
  const [activeView, setActiveView] = useState<ViewType>("rgb");
  const [transitionOpen, setTransitionOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRunAnalysis = useCallback(async () => {
    if (!location) { setError("Please select a location."); return; }
    if (!year1 || !year2) { setError("Please enter both Year A and Year B."); return; }
    if (parseInt(year1) === parseInt(year2)) { setError("Year A and Year B must be different."); return; }

    setError(null);
    setLoading(true);
    setResult(null);
    setActiveView("rgb");

    try {
      const resp = await fetch(
        `${API}/analysis?hotspot=${encodeURIComponent(location)}&year_a=${year1}&year_b=${year2}&k=5`
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail ? JSON.stringify(err.detail) : `Server error ${resp.status}`);
      }
      const data: AnalysisResult = await resp.json();
      setResult(data);
      setActiveView("rgb");
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [location, year1, year2]);

  const risk = result?.risk;
  const riskColor = risk?.level === "high" ? "text-red-500" : risk?.level === "moderate" ? "text-amber-500" : "text-emerald-500";

  // Sidebar nav items
  const navItems: { id: ViewType; icon: React.ElementType; label: string; hasDropdown?: boolean }[] = [
    { id: "district_map", icon: MapPinned, label: "District Explorer" },
    { id: "rgb",        icon: ImageIcon,  label: "Satellite RGB" },
    { id: "pca",        icon: Layers,     label: "PCA Embedding" },
    { id: "ndvi",       icon: TreePine,   label: "NDVI" },
    { id: "map",        icon: Map,        label: "Segmentation & Change" },
    { id: "transition", icon: BarChart3,  label: "Transition Matrix", hasDropdown: true },
    { id: "summary",    icon: FileText,   label: "Environmental Summary", hasDropdown: true },
    { id: "download",   icon: Download,   label: "Download Report" },
  ];

  const seg = result?.segmentation;
  const ndvi = result?.ndvi;
  return (
    <div
      className="min-h-screen bg-[#eef2ee] flex"
      style={{ fontFamily: "'DM Sans', 'Inter', system-ui, sans-serif" }}
    >
      {/* ── Sidebar ── */}
      <aside className="w-60 bg-[#0c2216] text-white flex flex-col shadow-2xl shrink-0 z-10">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-[#183526]">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] text-emerald-400 tracking-widest uppercase font-semibold">Monitoring</span>
          </div>
          <h1 className="text-sm font-bold text-white leading-snug">Ghana Land Change</h1>
          <p className="text-[11px] text-[#5d9a76] mt-0.5">Environmental Analysis</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ id, icon: Icon, label, hasDropdown }) => {
            const isActive = activeView === id;
            const disabled = !result && id !== "download" && id !== "district_map";
            const isDropOpen = (id === "transition" && transitionOpen) || (id === "summary" && summaryOpen);

            return (
              <button
                key={id}
                onClick={() => {
                  if (disabled) return;
                  setActiveView(id);
                  if (id === "transition") setTransitionOpen(p => !p);
                  if (id === "summary") setSummaryOpen(p => !p);
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left text-xs transition-all
                  ${isActive
                    ? "bg-emerald-600 text-white shadow-md"
                    : disabled
                      ? "text-[#2e5240] cursor-not-allowed"
                      : "text-[#8ec4a4] hover:bg-[#183526] hover:text-white"
                  }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="font-medium">{label}</span>
                </div>
                {hasDropdown && !disabled && (
                  <ChevronDown className={`w-3 h-3 transition-transform ${isDropOpen ? "rotate-180" : ""}`} />
                )}
              </button>
            );
          })}
        </nav>

        {/* Risk Score Panel */}
        <div className="px-4 py-4 border-t border-[#183526]">
          <div className="text-[10px] uppercase tracking-widest text-[#5d9a76] mb-2 font-semibold">Risk Score</div>
          <div className="bg-[#08150e] rounded-xl py-3 flex flex-col items-center">
            {risk ? (
              <RiskGauge score={risk.risk_score} level={risk.level} />
            ) : (
              <div className="py-6 text-[11px] text-[#2e5240] text-center">
                Run analysis to<br />compute score
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-100 shadow-sm px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-gray-800">Analysis Dashboard</h2>
            {result && (
              <p className="text-[11px] text-gray-400 mt-0.5">
                {result.hotspot} · {result.year_a} → {result.year_b}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Location */}
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-medium text-gray-500">Location</label>
              <div className="relative">
                <select
                  value={location}
                  onChange={e => setLocation(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs w-36 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 appearance-none pr-6"
                >
                  <option value="">Choose…</option>
                  {HOTSPOTS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <ChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Year A */}
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-gray-500">Year A</label>
              <div className="relative">
                <select
                  value={year1}
                  onChange={e => setYear1(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs w-20 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 appearance-none pr-6"
                >
                  <option value="">–</option>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <ChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Year B */}
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-gray-500">Year B</label>
              <div className="relative">
                <select
                  value={year2}
                  onChange={e => setYear2(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs w-20 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 appearance-none pr-6"
                >
                  <option value="">–</option>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <ChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {/* Run */}
            <button
              onClick={handleRunAnalysis}
              disabled={loading}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed active:scale-95 text-white px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm"
            >
              {loading
                ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                : <Activity className="w-3.5 h-3.5" />
              }
              {loading ? "Running…" : "Run Analysis"}
            </button>
          </div>
        </header>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mt-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-4 py-2.5 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Content */}
        <main className="flex-1 p-6 overflow-auto">
          {loading && <Spinner label={`Analysing ${location} (${year1}–${year2})…`} />}

          {!loading && activeView === "district_map" && (
            <DistrictMapPanel yearA={year1} yearB={year2} />
          )}

          {!loading && activeView !== "district_map" && !result && !error && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center max-w-xs">
                <div className="w-40 h-40 mx-auto rounded-3xl bg-gradient-to-br from-emerald-100 to-green-50 flex items-center justify-center mb-5 shadow-inner">
                  <Map className="w-16 h-16 text-emerald-300" />
                </div>
                <p className="text-gray-400 text-sm">Select a location and two years, then click <strong>Run Analysis</strong></p>
              </div>
            </div>
          )}

          {!loading && activeView !== "district_map" && result && (
            <>
              {/* ── RGB View ── */}
              {activeView === "rgb" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <SectionHeader
                    title={`Satellite RGB — ${result.hotspot}`}
                    subtitle="True-colour Sentinel imagery, min-max scaled per band"
                  />
                  <div className="grid grid-cols-2 gap-6">
                    <ImageCard b64={result.rgb.year_a.image} label={`RGB ${result.year_a}`} subtitle="Year A" />
                    <ImageCard b64={result.rgb.year_b.image} label={`RGB ${result.year_b}`} subtitle="Year B" />
                  </div>
                </div>
              )}

              {/* ── PCA View ── */}
              {activeView === "pca" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <SectionHeader
                    title={`PCA Embedding Visualisation — ${result.hotspot}`}
                    subtitle={`Ghana-wide AEF embedding cropped to ${result.hotspot} bounds, then PCA → RGB`}
                  />
                  <div className="grid grid-cols-2 gap-6">
                    <ImageCard b64={result.pca.year_a.image} label={`PCA ${result.year_a}`} subtitle="Year A" />
                    <ImageCard b64={result.pca.year_b.image} label={`PCA ${result.year_b}`} subtitle="Year B" />
                  </div>
                </div>
              )}

              {/* ── NDVI View ── */}
              {activeView === "ndvi" && ndvi && (
                <div className="space-y-5">
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <SectionHeader
                      title={`NDVI — ${result.hotspot}`}
                      subtitle="Normalised Difference Vegetation Index · RdYlGn colourmap (red = low, green = high)"
                    />
                    <div className="grid grid-cols-2 gap-6 mb-6">
                      <ImageCard
                        b64={ndvi.year_a.image}
                        label={`NDVI ${result.year_a}`}
                        subtitle={`Mean: ${ndvi.year_a.stats.mean.toFixed(3)} · ${ndvi.year_a.stats.positive_pct.toFixed(1)}% positive`}
                      />
                      <ImageCard
                        b64={ndvi.year_b.image}
                        label={`NDVI ${result.year_b}`}
                        subtitle={`Mean: ${ndvi.year_b.stats.mean.toFixed(3)} · ${ndvi.year_b.stats.positive_pct.toFixed(1)}% positive`}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <StatCard
                        label={`Mean NDVI ${result.year_a}`}
                        value={ndvi.year_a.stats.mean.toFixed(3)}
                        accent="text-emerald-600"
                      />
                      <StatCard
                        label={`Mean NDVI ${result.year_b}`}
                        value={ndvi.year_b.stats.mean.toFixed(3)}
                        accent="text-emerald-600"
                      />
                      <StatCard
                        label="Significant Loss Pixels"
                        value={ndvi.significant_loss_pixels.toLocaleString()}
                        accent="text-red-500"
                        sub="NDVI loss > 0.2"
                      />
                    </div>
                  </div>
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <SectionHeader
                      title="NDVI Loss Map"
                      subtitle={`Pixel-wise vegetation decline from ${result.year_a} → ${result.year_b} · Reds colourmap`}
                    />
                    <div className="max-w-sm">
                      <ImageCard b64={ndvi.loss_map} label="NDVI Loss" />
                    </div>
                  </div>
                </div>
              )}

              {/* ── Segmentation & Change Map View ── */}
              {activeView === "map" && seg && (
                <div className="space-y-5">
                  {/* Segmentation overlays */}
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <SectionHeader
                      title={`Land Cover Segmentation — ${result.hotspot}`}
                      subtitle="KMeans (k=5) on cropped AEF embeddings, smoothed with median filter · overlaid on RGB"
                    />
                    <div className="grid grid-cols-2 gap-6 mb-6">
                      <ImageCard b64={seg.year_a.seg_overlay} label={`Segmentation ${result.year_a}`} subtitle="Year A overlay" />
                      <ImageCard b64={seg.year_b.seg_overlay} label={`Segmentation ${result.year_b}`} subtitle="Year B overlay" />
                    </div>

                    {/* Class legend */}
                    <div className="mb-5">
                      <div className="text-xs font-semibold text-gray-600 mb-2">Class Legend</div>
                      <div className="flex flex-wrap gap-2">
                        {seg.year_a.labels.map((lbl, i) => (
                          <span key={i} className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 px-2.5 py-1 rounded-full border border-gray-200">
                            <span
                              className="w-2.5 h-2.5 rounded-sm shrink-0"
                              style={{ background: CLASS_COLORS[i % CLASS_COLORS.length] }}
                            />
                            {lbl}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Class distribution charts */}
                    <div className="grid grid-cols-2 gap-6">
                      <ClassDistChart dist={seg.year_a.distribution} title={`Class Distribution ${result.year_a}`} />
                      <ClassDistChart dist={seg.year_b.distribution} title={`Class Distribution ${result.year_b}`} />
                    </div>
                  </div>

                  {/* Change maps */}
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <SectionHeader
                      title="Embedding Change Maps"
                      subtitle="L2 norm of embedding difference between years · location-cropped"
                    />
                    <div className="grid grid-cols-2 gap-6">
                      <div>
                        <ImageCard
                          b64={seg.change_map}
                          label="Change Magnitude"
                          subtitle="Brighter = higher feature change"
                        />
                      </div>
                      <div>
                        <ImageCard
                          b64={seg.segmented_change}
                          label="Segmented Change Regions"
                          subtitle="4 quantile-based change levels"
                        />
                        <div className="flex gap-2 mt-3 flex-wrap">
                          {["Stable","Low change","Moderate","High change"].map((l, i) => (
                            <span key={l} className="flex items-center gap-1 text-[10px] text-gray-500">
                              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CHANGE_LEVEL_COLORS[i] }} />
                              {l}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 bg-gray-50 rounded-xl px-4 py-3 border border-gray-100">
                      <span className="text-xs text-gray-500">
                        <strong className="text-gray-700">{seg.major_change_pixels.toLocaleString()}</strong> pixels
                        show major embedding change (top 10% intensity)
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Transition Matrix ── */}
              {activeView === "transition" && seg && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <SectionHeader
                    title={`Land Cover Transition Matrix — ${result.hotspot}`}
                    subtitle={`${result.year_a} → ${result.year_b} · percentage of total pixels per class-pair`}
                  />
                  <TransitionMatrix
                    data={seg.transition_matrix.data}
                    labels={seg.transition_matrix.labels}
                    yearA={result.year_a}
                    yearB={result.year_b}
                  />
                </div>
              )}

              {/* ── Environmental Summary ── */}
              {activeView === "summary" && risk && (
                <div className="space-y-5">
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <SectionHeader
                      title={`Environmental Risk Assessment — ${result.hotspot}`}
                      subtitle={`${result.year_a} → ${result.year_b}`}
                    />
                    <div className="grid grid-cols-3 gap-4 mb-6">
                      <StatCard
                        label="Risk Score (0–10)"
                        value={risk.risk_score_10.toFixed(2)}
                        accent={riskColor}
                        sub={`Level: ${risk.level}`}
                      />
                      <StatCard
                        label="Major Change Pixels"
                        value={seg?.major_change_pixels.toLocaleString() ?? "–"}
                        accent="text-blue-600"
                        sub="Top 10% embedding change"
                      />
                      <StatCard
                        label="Significant NDVI Loss"
                        value={ndvi?.significant_loss_pixels.toLocaleString() ?? "–"}
                        accent="text-amber-600"
                        sub="NDVI drop > 0.2"
                      />
                    </div>

                    {/* Risk components bars */}
                    <div className="mb-2 text-xs font-semibold text-gray-600">Risk Component Breakdown</div>
                    <div className="space-y-3">
                      {[
                        { label: "Embedding Change", value: risk.components.embedding_change, weight: "50%", color: "#2563eb" },
                        { label: "NDVI Loss", value: risk.components.ndvi_loss, weight: "30%", color: "#d97706" },
                        { label: "Transition Instability", value: risk.components.transition_instability, weight: "20%", color: "#7c3aed" },
                      ].map(({ label, value, weight, color }) => (
                        <div key={label} className="flex items-center gap-3">
                          <div className="text-xs text-gray-500 w-44 shrink-0">
                            {label} <span className="text-gray-300">({weight})</span>
                          </div>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div
                              className="h-2 rounded-full transition-all"
                              style={{ width: `${Math.min(value * 100, 100)}%`, background: color }}
                            />
                          </div>
                          <div className="text-xs font-semibold text-gray-700 w-12 text-right">
                            {(value * 100).toFixed(1)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Alert banner */}
                  <div className={`rounded-2xl p-5 flex items-start gap-3 ${
                    risk.level === "high"
                      ? "bg-red-50 border border-red-100"
                      : risk.level === "moderate"
                        ? "bg-amber-50 border border-amber-100"
                        : "bg-emerald-50 border border-emerald-100"
                  }`}>
                    {risk.level === "high"
                      ? <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                      : risk.level === "moderate"
                        ? <Info className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                        : <CheckCircle className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                    }
                    <div>
                      <div className="text-sm font-bold text-gray-800">
                        {risk.level === "high"
                          ? "High Environmental Disturbance Detected"
                          : risk.level === "moderate"
                            ? "Moderate Environmental Change Detected"
                            : "Low Environmental Change — Area Appears Stable"
                        }
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {result.hotspot} shows a risk score of{" "}
                        <strong>{risk.risk_score_10.toFixed(2)}/10</strong> over the{" "}
                        {result.year_a}–{result.year_b} period.{" "}
                        {ndvi?.significant_loss_pixels.toLocaleString()} pixels show significant
                        vegetation loss, and {seg?.major_change_pixels.toLocaleString()} pixels
                        show major embedding change.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Download ── */}
              {activeView === "download" && (
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
                  <SectionHeader title="Download Report" subtitle="Export analysis results" />
                  <div className="flex flex-col items-center gap-4 py-8">
                    <Download className="w-12 h-12 text-gray-200" />
                    <p className="text-sm text-gray-400 text-center max-w-xs">
                      Connect <code className="bg-gray-100 px-1 rounded text-xs">GET /export/pdf</code> on your
                      FastAPI backend to generate a downloadable report from these results.
                    </p>
                    <button
                      disabled
                      className="bg-emerald-600 text-white px-6 py-2 rounded-lg text-sm font-semibold opacity-40 cursor-not-allowed"
                    >
                      Download PDF Report
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
