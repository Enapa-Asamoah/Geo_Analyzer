import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import {
  api,
  type NdviResponse,
  type NdviStats,
  type RiskResponse,
  type SegmentationResponse,
} from '@/services/api';

type AnalysisResults = {
  risk: RiskResponse;
  ndvi: NdviResponse;
  seg: SegmentationResponse;
};

const RISK_COLOR: Record<string, string> = {
  low: '#27ae60',
  moderate: '#f39c12',
  high: '#e74c3c',
};

export default function AnalysisScreen() {
  const colorScheme = useColorScheme();
  const theme = Colors[colorScheme ?? 'light'];

  const [locations, setLocations] = useState<string[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [hotspot, setHotspot] = useState<string | null>(null);
  const [yearA, setYearA] = useState<number | null>(null);
  const [yearB, setYearB] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AnalysisResults | null>(null);

  useEffect(() => {
    Promise.all([api.locations(), api.years()]).then(([loc, yr]) => {
      setLocations(loc.locations);
      setYears(yr.years);
    });
  }, []);

  async function runAnalysis() {
    if (!hotspot || !yearA || !yearB) {
      Alert.alert('Selection required', 'Please select a hotspot and two different years.');
      return;
    }
    if (yearA === yearB) {
      Alert.alert('Invalid selection', 'Year A and Year B must be different.');
      return;
    }
    setLoading(true);
    setResults(null);
    try {
      const [risk, ndvi, seg] = await Promise.all([
        api.risk(hotspot, yearA, yearB),
        api.ndvi(hotspot, yearA, yearB),
        api.segmentation(hotspot, yearA, yearB),
      ]);
      setResults({ risk, ndvi, seg });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Analysis failed. Check the backend server.';
      Alert.alert('Error', msg);
    } finally {
      setLoading(false);
    }
  }

  const canRun = !!hotspot && !!yearA && !!yearB && yearA !== yearB && !loading;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.title, { color: theme.text }]}>Analysis</Text>

        {/* Hotspot selector */}
        <Text style={[styles.sectionLabel, { color: theme.text }]}>Hotspot</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {locations.map((loc) => (
            <Chip
              key={loc}
              label={loc}
              selected={hotspot === loc}
              onPress={() => setHotspot(loc)}
              theme={theme}
            />
          ))}
        </ScrollView>

        {/* Year A selector */}
        <Text style={[styles.sectionLabel, { color: theme.text }]}>Year A (baseline)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {years.map((yr) => (
            <Chip
              key={yr}
              label={String(yr)}
              selected={yearA === yr}
              onPress={() => setYearA(yr)}
              theme={theme}
            />
          ))}
        </ScrollView>

        {/* Year B selector */}
        <Text style={[styles.sectionLabel, { color: theme.text }]}>Year B (comparison)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {years.map((yr) => (
            <Chip
              key={yr}
              label={String(yr)}
              selected={yearB === yr}
              onPress={() => setYearB(yr)}
              theme={theme}
            />
          ))}
        </ScrollView>

        {/* Run button */}
        <TouchableOpacity
          style={[
            styles.runButton,
            { backgroundColor: canRun ? theme.tint : theme.icon },
          ]}
          onPress={runAnalysis}
          disabled={!canRun}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.runButtonText}>Analyse</Text>
          )}
        </TouchableOpacity>

        {/* Results */}
        {results && (
          <>
            {/* ── Risk score ── */}
            <Text style={[styles.sectionLabel, { color: theme.text }]}>Environmental Risk</Text>
            <View
              style={[
                styles.riskCard,
                {
                  backgroundColor: RISK_COLOR[results.risk.level] + '22',
                  borderColor: RISK_COLOR[results.risk.level],
                },
              ]}>
              <Text style={[styles.riskScore, { color: RISK_COLOR[results.risk.level] }]}>
                {results.risk.risk_score_10.toFixed(1)}
                <Text style={styles.riskDenom}> / 10</Text>
              </Text>
              <Text style={[styles.riskLevel, { color: RISK_COLOR[results.risk.level] }]}>
                {results.risk.level.toUpperCase()}
              </Text>
              <View style={styles.riskDivider} />
              {Object.entries(results.risk.components).map(([k, v]) => (
                <View key={k} style={styles.componentRow}>
                  <Text style={[styles.componentLabel, { color: theme.text }]}>
                    {k.replace(/_/g, ' ')}
                  </Text>
                  <Text style={[styles.componentValue, { color: theme.text }]}>
                    {(v * 100).toFixed(1)}%
                  </Text>
                </View>
              ))}
            </View>

            {/* ── NDVI ── */}
            <Text style={[styles.sectionLabel, { color: theme.text }]}>
              NDVI — Vegetation Health
            </Text>
            <View style={styles.imageRow}>
              <ImageCard
                label={`Year ${yearA}`}
                base64={results.ndvi.year_a.image}
                stats={results.ndvi.year_a.stats}
                theme={theme}
              />
              <ImageCard
                label={`Year ${yearB}`}
                base64={results.ndvi.year_b.image}
                stats={results.ndvi.year_b.stats}
                theme={theme}
              />
            </View>
            <Text style={[styles.smallLabel, { color: theme.icon }]}>
              Loss map — {results.ndvi.significant_loss_pixels.toLocaleString()} significant loss
              pixels
            </Text>
            <Image
              source={{ uri: `data:image/png;base64,${results.ndvi.loss_map}` }}
              style={styles.fullImage}
              contentFit="contain"
            />

            {/* ── Segmentation ── */}
            <Text style={[styles.sectionLabel, { color: theme.text }]}>
              Land-Cover Segmentation
            </Text>
            <View style={styles.imageRow}>
              <ImageCard
                label={`Year ${yearA}`}
                base64={results.seg.year_a.seg_overlay}
                theme={theme}
              />
              <ImageCard
                label={`Year ${yearB}`}
                base64={results.seg.year_b.seg_overlay}
                theme={theme}
              />
            </View>
            <Text style={[styles.smallLabel, { color: theme.icon }]}>
              Change map — {results.seg.major_change_pixels.toLocaleString()} major-change pixels
            </Text>
            <Image
              source={{ uri: `data:image/png;base64,${results.seg.change_map}` }}
              style={styles.fullImage}
              contentFit="contain"
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Chip({
  label,
  selected,
  onPress,
  theme,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  theme: (typeof Colors)['light'];
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        selected
          ? { backgroundColor: theme.tint }
          : { borderColor: theme.icon, borderWidth: 1 },
      ]}>
      <Text style={[styles.chipText, { color: selected ? '#fff' : theme.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ImageCard({
  label,
  base64,
  stats,
  theme,
}: {
  label: string;
  base64: string;
  stats?: NdviStats;
  theme: (typeof Colors)['light'];
}) {
  return (
    <View style={styles.imageCard}>
      <Text style={[styles.imageLabel, { color: theme.text }]}>{label}</Text>
      <Image
        source={{ uri: `data:image/png;base64,${base64}` }}
        style={styles.halfImage}
        contentFit="cover"
      />
      {stats && (
        <Text style={[styles.statsText, { color: theme.icon }]}>
          Mean {stats.mean.toFixed(3)} · Veg {stats.positive_pct.toFixed(1)}%
        </Text>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 20 },
  sectionLabel: { fontSize: 15, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  smallLabel: { fontSize: 12, marginTop: 8, marginBottom: 4 },
  chipRow: { marginBottom: 4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginRight: 8 },
  chipText: { fontSize: 14 },
  runButton: { marginTop: 20, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  runButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  riskCard: { borderRadius: 16, borderWidth: 2, padding: 20, alignItems: 'center' },
  riskScore: { fontSize: 52, fontWeight: '800' },
  riskDenom: { fontSize: 24, fontWeight: '400' },
  riskLevel: { fontSize: 18, fontWeight: '700', marginTop: 4, letterSpacing: 2 },
  riskDivider: { width: '100%', height: 1, backgroundColor: '#ccc', marginVertical: 12 },
  componentRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 4 },
  componentLabel: { fontSize: 13, opacity: 0.8, textTransform: 'capitalize' },
  componentValue: { fontSize: 13, fontWeight: '600' },
  imageRow: { flexDirection: 'row', gap: 10 },
  imageCard: { flex: 1 },
  imageLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4, textAlign: 'center' },
  halfImage: { width: '100%', aspectRatio: 1, borderRadius: 8 },
  fullImage: { width: '100%', aspectRatio: 1.8, borderRadius: 8, marginBottom: 8 },
  statsText: { fontSize: 11, marginTop: 4, textAlign: 'center' },
});

