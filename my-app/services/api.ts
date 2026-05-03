import { Platform } from 'react-native';

/**
 * Base URL for the Ghana GeoAI FastAPI backend.
 * - Production: Use EXPO_PUBLIC_API_URL environment variable
 * - Android emulator: Routes to host machine via 10.0.2.2
 * - iOS simulator and web: Use localhost for development
 * - Physical device: Change to your PC's LAN IP shown in `npm start` output
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL;

export const BASE_URL =
  apiUrl ||
  (Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000');

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  let url = `${BASE_URL}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += `?${qs}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = JSON.stringify(body.detail);
    } catch {}
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type NdviStats = { mean: number; min: number; max: number; positive_pct: number };

export type YearImage = { year: number; image: string; stats?: NdviStats };

export type RiskLevel = 'low' | 'moderate' | 'high';

export type RiskResponse = {
  risk_score: number;
  risk_score_10: number;
  level: RiskLevel;
  components: {
    embedding_change: number;
    ndvi_loss: number;
    transition_instability: number;
  };
};

export type NdviResponse = {
  year_a: YearImage;
  year_b: YearImage;
  loss_map: string;
  significant_loss_pixels: number;
};

export type SegDistItem = { class_id: number; label: string; count: number; pct: number };

export type SegYear = {
  year: number;
  seg_overlay: string;
  seg_map: string;
  distribution: SegDistItem[];
  labels: string[];
};

export type SegmentationResponse = {
  year_a: SegYear;
  year_b: SegYear;
  change_map: string;
  segmented_change: string;
  major_change_pixels: number;
};

// ── API helpers ───────────────────────────────────────────────────────────────

export const api = {
  health: () => get<{ status: string }>('/health'),
  locations: () => get<{ locations: string[] }>('/locations'),
  years: () => get<{ years: number[] }>('/years'),
  rgb: (hotspot: string, year_a: number, year_b: number) =>
    get<{ year_a: YearImage; year_b: YearImage }>('/rgb', { hotspot, year_a, year_b }),
  ndvi: (hotspot: string, year_a: number, year_b: number) =>
    get<NdviResponse>('/ndvi', { hotspot, year_a, year_b }),
  segmentation: (hotspot: string, year_a: number, year_b: number, k = 5) =>
    get<SegmentationResponse>('/segmentation', { hotspot, year_a, year_b, k }),
  risk: (hotspot: string, year_a: number, year_b: number) =>
    get<RiskResponse>('/risk', { hotspot, year_a, year_b }),
};
