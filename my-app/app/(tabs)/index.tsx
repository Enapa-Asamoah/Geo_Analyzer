import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import ParallaxScrollView from '@/components/parallax-scroll-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { api } from '@/services/api';

type ApiStatus = 'checking' | 'ok' | 'error';

export default function HomeScreen() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    api.health()
      .then(() => setApiStatus('ok'))
      .catch(() => setApiStatus('error'));
  }, []);

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#1a5276', dark: '#0e2d47' }}
      headerImage={
        <View style={styles.headerContent}>
          <IconSymbol name="globe" size={90} color="rgba(255,255,255,0.85)" />
        </View>
      }>
      <ThemedView style={styles.titleRow}>
        <ThemedText type="title">GeoAI Monitor</ThemedText>
      </ThemedView>
      <ThemedText style={styles.subtitle}>Ghana Environmental Change Monitoring</ThemedText>

      <ThemedView style={styles.card}>
        <ThemedText type="defaultSemiBold">Backend Status</ThemedText>
        <View style={styles.statusRow}>
          {apiStatus === 'checking' && <ActivityIndicator size="small" />}
          {apiStatus === 'ok' && <View style={[styles.dot, { backgroundColor: '#27ae60' }]} />}
          {apiStatus === 'error' && <View style={[styles.dot, { backgroundColor: '#e74c3c' }]} />}
          <ThemedText style={styles.statusText}>
            {apiStatus === 'checking'
              ? '  Connecting…'
              : apiStatus === 'ok'
                ? '  API Online'
                : '  API Offline — start the backend server'}
          </ThemedText>
        </View>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="defaultSemiBold">What it does</ThemedText>
        <ThemedText style={styles.body}>
          Select a mining hotspot, pick two years, and run a full environmental change analysis —
          NDVI vegetation health, land-cover segmentation, and an AI-based risk score.
        </ThemedText>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="defaultSemiBold">Monitored Locations</ThemedText>
        <ThemedText style={styles.body}>
          Obuasi · Tarkwa · Dunkwa · Bui · Wa · Prestea · Bibiani and more
        </ThemedText>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="defaultSemiBold">Getting Started</ThemedText>
        <ThemedText style={styles.body}>
          Head to the <ThemedText type="defaultSemiBold">Analysis</ThemedText> tab, choose a
          hotspot and two years, then tap <ThemedText type="defaultSemiBold">Analyse</ThemedText>.
        </ThemedText>
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  headerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleRow: { marginTop: 8 },
  subtitle: { opacity: 0.6, marginBottom: 16, fontSize: 14 },
  card: { borderRadius: 12, padding: 16, marginBottom: 12, gap: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 14 },
  body: { opacity: 0.8, lineHeight: 22 },
});
