import numpy as np
import rasterio
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans
from rasterio.windows import from_bounds
from scipy.ndimage import median_filter


def _minmax_scale(array: np.ndarray) -> np.ndarray:
    array = np.nan_to_num(array.astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    min_value = np.min(array)
    max_value = np.max(array)
    if max_value - min_value < 1e-9:
        return np.zeros_like(array, dtype=np.float32)
    return (array - min_value) / (max_value - min_value)


def load_rgb(path: str) -> np.ndarray:
    with rasterio.open(path) as source:
        rgb = source.read([1, 2, 3]).astype(np.float32)
    rgb = np.transpose(rgb, (1, 2, 0))
    rgb = _minmax_scale(rgb)
    return (rgb * 255).astype(np.uint8)


def load_ndvi(path: str) -> np.ndarray:
    with rasterio.open(path) as source:
        ndvi = source.read(1).astype(np.float32)
    return np.nan_to_num(ndvi, nan=0.0)


def load_embedding(path: str) -> np.ndarray:
    with rasterio.open(path) as source:
        embedding = source.read().astype(np.float32)
    return np.nan_to_num(embedding, nan=0.0)


def embedding_pca_rgb(embedding: np.ndarray) -> np.ndarray:
    bands, height, width = embedding.shape
    reshaped = embedding.reshape(bands, -1).T
    pca = PCA(n_components=3)
    rgb = pca.fit_transform(reshaped)
    rgb = rgb.reshape(height, width, 3)
    rgb = _minmax_scale(rgb)
    return (rgb * 255).astype(np.uint8)


def embedding_change(embedding_a: np.ndarray, embedding_b: np.ndarray) -> np.ndarray:
    change = np.linalg.norm(embedding_b - embedding_a, axis=0)
    return _minmax_scale(change)


def kmeans_segment(embedding: np.ndarray, k: int = 5) -> np.ndarray:
    bands, height, width = embedding.shape
    reshaped = embedding.reshape(bands, -1).T
    kmeans = KMeans(n_clusters=k, random_state=42, n_init=10)
    labels = kmeans.fit_predict(reshaped)
    segmented = labels.reshape(height, width)
    return segmented


def segment_change(change_map: np.ndarray) -> np.ndarray:
    thresholds = np.quantile(change_map, [0.25, 0.5, 0.75])
    segmented = np.digitize(change_map, bins=thresholds, right=False)
    return segmented.astype(np.int16)


def crop_embedding_to_match(embedding_path: str, reference_raster_path: str) -> np.ndarray:
    """Crop the Ghana-wide embedding to match the bounds of a location-specific sentinel raster."""
    with rasterio.open(reference_raster_path) as ref:
        ref_bounds = ref.bounds

    with rasterio.open(embedding_path) as emb:
        window = from_bounds(
            ref_bounds.left,
            ref_bounds.bottom,
            ref_bounds.right,
            ref_bounds.top,
            emb.transform
        )
        embedding = emb.read(window=window).astype(np.float32)

    return np.nan_to_num(embedding, nan=0.0)


def smooth_segmentation(segmentation: np.ndarray) -> np.ndarray:
    return median_filter(segmentation, size=5)


def compute_transition_matrix(segA: np.ndarray, segB: np.ndarray, num_classes: int = None):
    """
    Fixed version: returns a proper (num_classes x num_classes) transition matrix.
    segA and segB must be same shape. Each cell [i,j] = pixels that were class i → class j.
    """
    if num_classes is None:
        max_class = int(max(np.max(segA), np.max(segB)))
        num_classes = max_class + 1

    transition_matrix = np.zeros((num_classes, num_classes), dtype=np.int64)
    for i in range(num_classes):
        for j in range(num_classes):
            transition_matrix[i, j] = int(np.sum((segA == i) & (segB == j)))

    return transition_matrix


def ndvi_loss(ndviA: np.ndarray, ndviB: np.ndarray) -> np.ndarray:
    loss = ndviA - ndviB
    return _minmax_scale(loss)


def compute_risk(change_map: np.ndarray, ndvi_loss_map: np.ndarray, transition_matrix: np.ndarray):
    emb_component = float(np.mean(change_map))
    ndvi_component = float(np.mean(ndvi_loss_map))
    instability = float(np.sum(transition_matrix) - np.trace(transition_matrix))
    instability_component = instability / (float(np.sum(transition_matrix)) + 1e-9)
    risk_score = 0.5 * emb_component + 0.3 * ndvi_component + 0.2 * instability_component
    return risk_score, emb_component, ndvi_component, instability_component


def assign_class_labels(kmeans_centers: np.ndarray, ndvi_values: np.ndarray) -> list:
    """
    Assign semantic land cover labels to KMeans clusters based on mean NDVI per cluster.
    Sorts clusters by mean NDVI and assigns labels from lowest to highest.
    """
    k = kmeans_centers.shape[0] if hasattr(kmeans_centers, 'shape') else len(kmeans_centers)
    labels = ['Water / Shadow', 'Bare Soil / Degraded', 'Sparse Vegetation', 'Shrubland / Grassland', 'Dense Forest']
    
    if k <= 5:
        # Compute mean NDVI per cluster
        cluster_ndvi = {}
        flat_ndvi = ndvi_values.flatten()
        flat_seg = kmeans_centers  # passed as segmentation array here
        for c in range(k):
            mask = flat_seg.flatten() == c
            if mask.sum() > 0:
                cluster_ndvi[c] = float(np.mean(flat_ndvi[mask]))
            else:
                cluster_ndvi[c] = 0.0
        
        sorted_clusters = sorted(cluster_ndvi.keys(), key=lambda x: cluster_ndvi[x])
        label_map = {}
        for rank, cluster_id in enumerate(sorted_clusters):
            label_map[cluster_id] = labels[rank] if rank < len(labels) else f'Class {cluster_id}'
        return [label_map.get(i, f'Class {i}') for i in range(k)]
    else:
        return [f'Class {i}' for i in range(k)]
