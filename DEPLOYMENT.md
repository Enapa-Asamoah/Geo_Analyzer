# Render Deployment Guide

## Prerequisites
- GitHub repository with your code
- Render account (https://render.com)

## Deployment Steps

### Option 1: Using render.yaml (Recommended)
1. Push your code to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New" → "Blueprint"
4. Connect your GitHub repository
5. Select the branch and confirm
6. Render will automatically deploy both backend and frontend

### Option 2: Manual Deployment

#### Deploy Backend
1. In Render Dashboard, click "New" → "Web Service"
2. Connect your GitHub repository
3. Configure:
   - **Name:** geoai-backend
   - **Root Directory:** backend
   - **Runtime:** Python 3.11
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn main:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --timeout 120 --bind 0.0.0.0:8000`
   - **Environment Variables:**
     - `PYTHONUNBUFFERED=true`

#### Deploy Frontend
1. Click "New" → "Static Site"
2. Connect your GitHub repository
3. Configure:
   - **Name:** geoai-frontend
   - **Root Directory:** frontend
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** dist

## Important Notes

- The backend data files (`backend/data/`) should be excluded from Git and managed separately
- For production, tighten CORS in `backend/main.py` (currently allows all origins)
- The frontend will auto-link to the backend URL via the `render.yaml` configuration

## Data Management

Your data files (sentinel imagery, embeddings, etc.) are large and shouldn't be in Git. Consider:
- Using AWS S3 or similar cloud storage
- Mounting persistent volumes on Render
- Loading data on startup

## Monitoring

After deployment:
- View logs in Render Dashboard
- Check `/health` endpoint to confirm backend is running
- Test API endpoints from frontend
