"""
Ghana Environmental Change Monitoring — FastAPI Backend
-------------------------------------------------------
Serves all analysis results as JSON to the React frontend.

Data layout expected on disk:
  data/sentinel/{hotspot}/{hotspot}_RGB_{year}.tif
  data/sentinel/{hotspot}/{hotspot}_NDVI_{year}.tif
  data/embeddings/AEF_{year}.tif

Run with:
  uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

import os
import base64
import io
import re
from functools import lru_cache
from typing import Any, Optional

import numpy as np
import shapefile
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from utils import (
    load_rgb,
    load_ndvi,
    embedding_pca_rgb,
    kmeans_segment,
    embedding_change,
    segment_change,
    crop_embedding_to_match,
    smooth_segmentation,
    compute_transition_matrix,
    ndvi_loss,
    compute_risk,
    assign_class_labels,
    _minmax_scale,
)

app = FastAPI(title="Ghana Environmental Change API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # tighten for production
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_ROOT = os.environ.get("DATA_ROOT", "./data")
DISTRICT_TIFF_DIR = os.path.join(DATA_ROOT, "districts", "tiffs")

# Map hotspot folders to one or more district labels in the shapefile.
# This mapping can be expanded as more district-level data becomes available.
HOTSPOT_TO_DISTRICTS = {
    "Obuasi": ["Obuasi Municipal", "Obuasi East"],
    "Tarkwa": ["Tarkwa-Nsuaem Municipal"],
    "Dunkwa": ["Upper Denkyira East Municipal", "Upper Denkyira West"],
    "Bui": ["Builsa North Municipal", "Builsa South"],
    "Wa": ["Wa Municipal", "Wa East", "Wa West"],
}


# ── helpers ──────────────────────────────────────────────────────────────────

def _rgb_to_b64(arr: np.ndarray) -> str:
    """Convert H×W×3 uint8 array → base64 PNG string."""
    img = Image.fromarray(arr.astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _float2d_to_b64(arr: np.ndarray, colormap: str = "RdYlGn") -> str:
    """Convert 2-D float [0-1] array → base64 PNG via matplotlib colormap."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.cm as cm

    cmap = cm.get_cmap(colormap)
    rgba = cmap(arr)
    rgb = (rgba[:, :, :3] * 255).astype(np.uint8)
    img = Image.fromarray(rgb)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _seg_to_b64(seg: np.ndarray, k: int = 5) -> str:
    """Convert integer segmentation map → base64 PNG using tab20 colormap."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.cm as cm

    cmap = cm.get_cmap("tab20", k)
    rgb = (cmap(seg / max(k - 1, 1))[:, :, :3] * 255).astype(np.uint8)
    img = Image.fromarray(rgb)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _paths(hotspot: str, year: int):
    base = DATA_ROOT
    return {
        "rgb":   f"{base}/sentinel/{hotspot}/{hotspot}_RGB_{year}.tif",
        "ndvi":  f"{base}/sentinel/{hotspot}/{hotspot}_NDVI_{year}.tif",
        "emb":   f"{base}/embeddings/AEF_{year}.tif",
    }


def _check_files(*paths):
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        raise HTTPException(
            status_code=404,
            detail={"missing_files": missing},
        )


@lru_cache(maxsize=1)
def _district_tiff_index() -> dict[str, dict[int, str]]:
    """
    Build an index of district RGB TIFFs on disk:
      { normalized_district_name: { year: absolute_path } }
    Supports both .tif and .tiff extensions.
    """
    if not os.path.isdir(DISTRICT_TIFF_DIR):
        return {}

    pattern = re.compile(r"^(?P<district>.+)_RGB_(?P<year>\d{4})\.(?P<ext>tif|tiff)$", re.IGNORECASE)
    index: dict[str, dict[int, str]] = {}

    for name in os.listdir(DISTRICT_TIFF_DIR):
        matched = pattern.match(name)
        if not matched:
            continue

        district_raw = matched.group("district").replace("_", " ").strip()
        year = int(matched.group("year"))
        norm = _norm_name(district_raw)
        index.setdefault(norm, {})[year] = os.path.join(DISTRICT_TIFF_DIR, name)

    return index


def _district_rgb_path(district_label: str, year: int) -> Optional[str]:
    by_year = _district_tiff_index().get(_norm_name(district_label), {})
    return by_year.get(year)


def _district_years(district_label: str) -> list[int]:
    by_year = _district_tiff_index().get(_norm_name(district_label), {})
    return sorted(by_year.keys())


def _norm_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _shape_to_geojson_geometry(shape: shapefile.Shape) -> dict[str, Any]:
    """Convert a pyshp polygon shape into GeoJSON geometry."""
    points = shape.points
    parts = list(shape.parts) + [len(points)]
    rings = []
    for i in range(len(parts) - 1):
        start = parts[i]
        end = parts[i + 1]
        ring = [[float(x), float(y)] for x, y in points[start:end]]
        if ring:
            rings.append(ring)

    if not rings:
        return {"type": "Polygon", "coordinates": []}

    if len(rings) == 1:
        return {"type": "Polygon", "coordinates": [rings[0]]}

    # Multi-part polygons are represented as MultiPolygon with one ring each.
    return {
        "type": "MultiPolygon",
        "coordinates": [[[ring_point for ring_point in ring]] for ring in rings],
    }


@lru_cache(maxsize=1)
def _district_feature_collection_base() -> dict[str, Any]:
    shp_path = os.path.join(DATA_ROOT, "districts", "District_272.shp")
    if not os.path.exists(shp_path):
        raise HTTPException(status_code=404, detail={"missing_files": [shp_path]})

    with shapefile.Reader(shp_path) as reader:
        field_names = [f[0] for f in reader.fields[1:]]
        records = [dict(zip(field_names, record)) for record in reader.records()]
        shapes = reader.shapes()

    available_hotspots = {
        folder
        for folder in os.listdir(os.path.join(DATA_ROOT, "sentinel"))
        if os.path.isdir(os.path.join(DATA_ROOT, "sentinel", folder))
    } if os.path.isdir(os.path.join(DATA_ROOT, "sentinel")) else set()

    district_to_hotspot: dict[str, str] = {}
    for hotspot, districts in HOTSPOT_TO_DISTRICTS.items():
        if hotspot not in available_hotspots:
            continue
        for district in districts:
            district_to_hotspot[_norm_name(district)] = hotspot

    features = []
    for record, shape in zip(records, shapes):
        district = str(record.get("Label") or record.get("District") or "").strip()
        region = str(record.get("Region") or "").strip()
        hotspot = district_to_hotspot.get(_norm_name(district))
        years = _district_years(district)
        has_data = len(years) > 0
        min_x, min_y, max_x, max_y = shape.bbox
        centroid = [(min_y + max_y) / 2.0, (min_x + max_x) / 2.0]  # [lat, lon]

        features.append({
            "type": "Feature",
            "geometry": _shape_to_geojson_geometry(shape),
            "properties": {
                "district": district,
                "region": region,
                "hotspot": hotspot,
                "has_data": has_data,
                "years": years,
                "centroid": centroid,
            },
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "with_data": sum(1 for f in features if f["properties"]["has_data"]),
            "without_data": sum(1 for f in features if not f["properties"]["has_data"]),
            "hotspots": sorted(list(available_hotspots)),
        },
    }


def _district_feature_collection(year_a: Optional[int] = None, year_b: Optional[int] = None) -> dict[str, Any]:
    """Return feature collection; optionally mark availability for specific year pair."""
    base = _district_feature_collection_base()
    features = []
    with_data = 0

    for feature in base["features"]:
        props = dict(feature["properties"])
        years = set(props.get("years", []))
        if year_a is not None and year_b is not None:
            has_data = year_a in years and year_b in years
        else:
            has_data = len(years) > 0

        props["has_data"] = has_data
        if has_data:
            with_data += 1

        features.append({
            "type": "Feature",
            "geometry": feature["geometry"],
            "properties": props,
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "with_data": with_data,
            "without_data": len(features) - with_data,
            "hotspots": base["meta"]["hotspots"],
            "year_filter": {"year_a": year_a, "year_b": year_b},
        },
    }


# ── routes ───────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "service": "Ghana Environmental Change API",
        "status": "ok",
        "health": "/health",
        "docs": "/docs",
    }

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/locations")
def list_locations():
    """Return available hotspot names from disk."""
    sentinel_dir = os.path.join(DATA_ROOT, "sentinel")
    if not os.path.isdir(sentinel_dir):
        return {"locations": [
            "Obuasi", "Tarkwa", "Prestea", "Bibiani", "Dunkwa",
            "Konongo", "Goaso", "Kibi", "Winneba", "Bekwai",
            "Sefwi-Bekwai", "Bui", "Bole", "Nangodi", "Wa", "Lawra"
        ]}
    return {"locations": sorted(os.listdir(sentinel_dir))}


@app.get("/years")
def list_years():
    return {"years": [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]}


@app.get("/districts/map")
def districts_map(
    year_a: Optional[int] = Query(None),
    year_b: Optional[int] = Query(None),
):
    """Return district polygons and data-availability status for the map."""
    if (year_a is None) ^ (year_b is None):
        raise HTTPException(status_code=400, detail="Provide both year_a and year_b, or neither.")
    return _district_feature_collection(year_a=year_a, year_b=year_b)


@app.get("/districts/insight")
def district_insight(
    district: str = Query(..., description="District label from shapefile"),
    year_a: int = Query(...),
    year_b: int = Query(...),
):
    """Return popup payload (RGB, PCA, risk) for a selected district when available."""
    district_norm = _norm_name(district)
    collection = _district_feature_collection()
    matched = next(
        (f for f in collection["features"] if _norm_name(f["properties"]["district"]) == district_norm),
        None,
    )

    if matched is None:
        raise HTTPException(status_code=404, detail=f"District not found: {district}")

    district_label = matched["properties"]["district"]
    rgb_path_a = _district_rgb_path(district_label, year_a)
    rgb_path_b = _district_rgb_path(district_label, year_b)
    if not rgb_path_a or not rgb_path_b:
        raise HTTPException(
            status_code=404,
            detail={
                "message": f"Missing district RGB for selected years: {district}",
                "available_years": _district_years(district_label),
                "requested_years": [year_a, year_b],
            },
        )

    emb_path_a = os.path.join(DATA_ROOT, "embeddings", f"AEF_{year_a}.tif")
    emb_path_b = os.path.join(DATA_ROOT, "embeddings", f"AEF_{year_b}.tif")
    _check_files(rgb_path_a, rgb_path_b, emb_path_a, emb_path_b)

    # RGB
    rgbA = load_rgb(rgb_path_a)
    rgbB = load_rgb(rgb_path_b)
    rgb_data = {
        "year_a": {"year": year_a, "image": _rgb_to_b64(rgbA)},
        "year_b": {"year": year_b, "image": _rgb_to_b64(rgbB)},
    }

    # PCA on district-cropped embeddings
    embA = crop_embedding_to_match(emb_path_a, rgb_path_a)
    embB = crop_embedding_to_match(emb_path_b, rgb_path_b)
    pca_data = {
        "year_a": {"year": year_a, "image": _rgb_to_b64(embedding_pca_rgb(embA))},
        "year_b": {"year": year_b, "image": _rgb_to_b64(embedding_pca_rgb(embB))},
    }

    # District risk summary from embedding change + transition instability.
    change_map = embedding_change(embA, embB)
    segA = smooth_segmentation(kmeans_segment(embA))
    segB = smooth_segmentation(kmeans_segment(embB))
    trans_mat = compute_transition_matrix(segA, segB)
    zero_loss = np.zeros_like(change_map, dtype=np.float32)
    risk, emb_comp, ndvi_comp, instability = compute_risk(change_map, zero_loss, trans_mat)
    level = "high" if risk > 0.6 else "moderate" if risk > 0.3 else "low"
    risk_data = {
        "risk_score": round(float(risk), 4),
        "risk_score_10": round(float(risk) * 10, 2),
        "level": level,
        "components": {
            "embedding_change": round(emb_comp, 4),
            "ndvi_loss": round(ndvi_comp, 4),
            "transition_instability": round(instability, 4),
        },
    }

    return {
        "district": district_label,
        "region": matched["properties"]["region"],
        "hotspot": matched["properties"].get("hotspot") or "district-rgb",
        "year_a": year_a,
        "year_b": year_b,
        "rgb": rgb_data,
        "pca": pca_data,
        "risk": risk_data,
    }


@app.get("/rgb")
def get_rgb(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
):
    """Return base64 RGB images for two years."""
    pA = _paths(hotspot, year_a)
    pB = _paths(hotspot, year_b)
    _check_files(pA["rgb"], pB["rgb"])

    rgbA = load_rgb(pA["rgb"])
    rgbB = load_rgb(pB["rgb"])

    return {
        "year_a": {"year": year_a, "image": _rgb_to_b64(rgbA)},
        "year_b": {"year": year_b, "image": _rgb_to_b64(rgbB)},
    }


@app.get("/pca")
def get_pca(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
):
    """Return PCA RGB images of cropped embeddings for two years."""
    pA = _paths(hotspot, year_a)
    pB = _paths(hotspot, year_b)
    _check_files(pA["rgb"], pA["emb"], pB["rgb"], pB["emb"])

    # Crop Ghana-wide embedding to this hotspot's sentinel bounds
    embA = crop_embedding_to_match(pA["emb"], pA["rgb"])
    embB = crop_embedding_to_match(pB["emb"], pB["rgb"])

    pcaA = embedding_pca_rgb(embA)
    pcaB = embedding_pca_rgb(embB)

    return {
        "year_a": {"year": year_a, "image": _rgb_to_b64(pcaA)},
        "year_b": {"year": year_b, "image": _rgb_to_b64(pcaB)},
    }


@app.get("/ndvi")
def get_ndvi(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
):
    """Return NDVI images + pixel statistics for two years."""
    pA = _paths(hotspot, year_a)
    pB = _paths(hotspot, year_b)
    _check_files(pA["ndvi"], pB["ndvi"])

    ndviA = load_ndvi(pA["ndvi"])
    ndviB = load_ndvi(pB["ndvi"])

    loss_map = ndvi_loss(ndviA, ndviB)

    def ndvi_stats(arr):
        return {
            "mean": float(np.mean(arr)),
            "min":  float(np.min(arr)),
            "max":  float(np.max(arr)),
            "positive_pct": float(np.mean(arr > 0) * 100),
        }

    return {
        "year_a": {
            "year": year_a,
            "image": _float2d_to_b64(_minmax_scale(ndviA), "RdYlGn"),
            "stats": ndvi_stats(ndviA),
        },
        "year_b": {
            "year": year_b,
            "image": _float2d_to_b64(_minmax_scale(ndviB), "RdYlGn"),
            "stats": ndvi_stats(ndviB),
        },
        "loss_map": _float2d_to_b64(loss_map, "Reds"),
        "significant_loss_pixels": int(np.sum(loss_map > 0.2)),
    }


@app.get("/segmentation")
def get_segmentation(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
    k: int = Query(5, ge=2, le=10),
):
    """
    Return:
    - Segmentation overlay images for year A and B
    - Class labels (based on NDVI ranking)
    - Class distribution (pixel counts per class, per year)
    - Change map + segmented change
    - Transition matrix (fixed)
    """
    pA = _paths(hotspot, year_a)
    pB = _paths(hotspot, year_b)
    _check_files(pA["rgb"], pA["emb"], pA["ndvi"], pB["rgb"], pB["emb"], pB["ndvi"])

    # Load data
    rgbA = load_rgb(pA["rgb"])
    rgbB = load_rgb(pB["rgb"])
    ndviA = load_ndvi(pA["ndvi"])
    ndviB = load_ndvi(pB["ndvi"])

    # Crop Ghana-wide embeddings to hotspot bounds
    embA = crop_embedding_to_match(pA["emb"], pA["rgb"])
    embB = crop_embedding_to_match(pB["emb"], pB["rgb"])

    # Segment (KMeans on cropped embedding)
    segA_raw = kmeans_segment(embA, k=k)
    segB_raw = kmeans_segment(embB, k=k)
    segA = smooth_segmentation(segA_raw)
    segB = smooth_segmentation(segB_raw)

    # Semantic labels based on NDVI ranking per cluster
    labelsA = assign_class_labels(segA, ndviA)
    labelsB = assign_class_labels(segB, ndviB)

    # Class distribution (pixel counts)
    def class_distribution(seg, labels, k):
        total = seg.size
        dist = []
        for c in range(k):
            count = int(np.sum(seg == c))
            dist.append({
                "class_id": c,
                "label": labels[c],
                "count": count,
                "pct": round(count / total * 100, 2),
            })
        return dist

    distA = class_distribution(segA, labelsA, k)
    distB = class_distribution(segB, labelsB, k)

    # Change map (on cropped embeddings)
    change_map = embedding_change(embA, embB)
    seg_change = segment_change(change_map)

    # Transition matrix (fixed — uses same k, same pixel grid)
    trans_mat = compute_transition_matrix(segA, segB, num_classes=k)

    # Render segmentation overlaid on RGB
    def seg_overlay_b64(rgb_arr, seg_arr, k_val):
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.cm as cm
        fig, ax = plt.subplots(figsize=(6, 4), dpi=100)
        ax.imshow(rgb_arr)
        ax.imshow(seg_arr, cmap="tab20", alpha=0.35, vmin=0, vmax=k_val - 1)
        ax.axis("off")
        buf = io.BytesIO()
        plt.savefig(buf, format="png", bbox_inches="tight", pad_inches=0)
        plt.close(fig)
        return base64.b64encode(buf.getvalue()).decode()

    return {
        "year_a": {
            "year": year_a,
            "seg_overlay": seg_overlay_b64(rgbA, segA, k),
            "seg_map": _seg_to_b64(segA, k),
            "distribution": distA,
            "labels": labelsA,
        },
        "year_b": {
            "year": year_b,
            "seg_overlay": seg_overlay_b64(rgbB, segB, k),
            "seg_map": _seg_to_b64(segB, k),
            "distribution": distB,
            "labels": labelsB,
        },
        "change_map": _float2d_to_b64(change_map, "hot_r"),
        "segmented_change": _seg_to_b64(seg_change.astype(np.int32), 4),
        "transition_matrix": {
            "data": trans_mat.tolist(),
            "labels": labelsA,   # year A classes as row labels
            "k": k,
        },
        "major_change_pixels": int(np.sum(change_map > 0.9)),
    }


@app.get("/risk")
def get_risk(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
):
    """Compute and return the environmental risk score and components."""
    pA = _paths(hotspot, year_a)
    pB = _paths(hotspot, year_b)
    _check_files(pA["ndvi"], pB["ndvi"], pA["emb"], pA["rgb"], pB["emb"], pB["rgb"])

    ndviA = load_ndvi(pA["ndvi"])
    ndviB = load_ndvi(pB["ndvi"])
    embA = crop_embedding_to_match(pA["emb"], pA["rgb"])
    embB = crop_embedding_to_match(pB["emb"], pB["rgb"])

    change_map = embedding_change(embA, embB)
    loss_map = ndvi_loss(ndviA, ndviB)

    segA = smooth_segmentation(kmeans_segment(embA))
    segB = smooth_segmentation(kmeans_segment(embB))
    trans_mat = compute_transition_matrix(segA, segB)

    risk, emb_comp, ndvi_comp, instability = compute_risk(change_map, loss_map, trans_mat)

    level = "high" if risk > 0.6 else "moderate" if risk > 0.3 else "low"

    return {
        "risk_score": round(float(risk), 4),
        "risk_score_10": round(float(risk) * 10, 2),
        "level": level,
        "components": {
            "embedding_change": round(emb_comp, 4),
            "ndvi_loss": round(ndvi_comp, 4),
            "transition_instability": round(instability, 4),
        },
    }


@app.get("/analysis")
def run_full_analysis(
    hotspot: str = Query(...),
    year_a: int = Query(...),
    year_b: int = Query(...),
    k: int = Query(5, ge=2, le=10),
):
    """
    Single endpoint that returns everything: RGB, PCA, NDVI, segmentation,
    change map, transition matrix, risk score. Avoids multiple round-trips.
    """
    rgb_data = get_rgb(hotspot=hotspot, year_a=year_a, year_b=year_b)
    pca_data = get_pca(hotspot=hotspot, year_a=year_a, year_b=year_b)
    ndvi_data = get_ndvi(hotspot=hotspot, year_a=year_a, year_b=year_b)
    seg_data = get_segmentation(hotspot=hotspot, year_a=year_a, year_b=year_b, k=k)
    risk_data = get_risk(hotspot=hotspot, year_a=year_a, year_b=year_b)

    return {
        "hotspot": hotspot,
        "year_a": year_a,
        "year_b": year_b,
        "rgb": rgb_data,
        "pca": pca_data,
        "ndvi": ndvi_data,
        "segmentation": seg_data,
        "risk": risk_data,
    }
