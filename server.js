const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const gdal = require('gdal-async');
const proj4 = require('proj4');
const sharp = require('sharp');

const app = express();
const port = 3000;

// Configurações globais
let gdalDataset = null;
let imageInfo = null;

app.use(cors());

// Verificar se o diretório de dados existe
const dataPath = path.join(__dirname, 'data');
if (!fs.existsSync(dataPath)) {
  console.log(`Criando diretório de dados em ${dataPath}`);
  fs.mkdirSync(dataPath, { recursive: true });
}

// Função para obter a projeção do dataset de forma segura
function getSafeProjection(dataset) {
  if (!dataset.srs) return null;
  
  // Tentar obter a projeção como string WKT
  try {
    return dataset.srs.toWKT();
  } catch (error) {
    console.error('Erro ao obter WKT da projeção:', error);
  }
  
  // Fallback para UTM Zone 22S (comum no Brasil)
  return '+proj=utm +zone=22 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
}

// Função para inicializar o dataset GDAL
function initGdalDataset() {
  if (!gdalDataset) {
    const tifPath = path.join(dataPath, 'Iturama-2019.tif');
    if (!fs.existsSync(tifPath)) {
      throw new Error('Arquivo TIF não encontrado');
    }
    
    gdalDataset = gdal.open(tifPath);
    const width = gdalDataset.rasterSize.x;
    const height = gdalDataset.rasterSize.y;
    const [originX, pixelWidth, skewX, originY, skewY, pixelHeight] = gdalDataset.geoTransform;
    
    // Calcular os limites geográficos do GeoTIFF em sua projeção nativa
    const minX = originX;
    const maxX = originX + width * pixelWidth;
    const minY = originY + height * pixelHeight; // Normalmente negativo para UTM sul
    const maxY = originY;
    
    // Obter a projeção do GeoTIFF de forma segura
    const projection = getSafeProjection(gdalDataset);
    
    imageInfo = {
      width,
      height,
      originX,
      originY,
      pixelWidth,
      pixelHeight,
      skewX,
      skewY,
      projection,
      bounds: {
        minX,
        minY,
        maxX,
        maxY
      }
    };
    
    console.log('Dataset inicializado:', JSON.stringify(imageInfo, null, 2));
    
    // Converter os limites para WGS84 (EPSG:4326) para referência
    try {
      if (projection) {
        const nw = proj4(projection, 'EPSG:4326', [minX, maxY]);
        const se = proj4(projection, 'EPSG:4326', [maxX, minY]);
        console.log('Limites em WGS84:', {
          northwest: { lon: nw[0], lat: nw[1] },
          southeast: { lon: se[0], lat: se[1] }
        });
      }
    } catch (error) {
      console.error('Erro ao converter limites para WGS84:', error);
    }
  }
  return { dataset: gdalDataset, info: imageInfo };
}

// Middleware para logging de requisições
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Rota para obter informações do TIF
app.get('/api/tif-info', (req, res) => {
  try {
    const { dataset, info } = initGdalDataset();
    res.json(info);
  } catch (error) {
    console.error('Erro ao obter informações do TIF:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cache para armazenar tiles já processados
const tileCache = new Map();

app.get('/api/tiles/:z/:x/:y', async (req, res) => {
  const tileSize = 256;
  
  // Função auxiliar para enviar um tile vazio
  const sendEmptyTile = async () => {
    res.setHeader('Content-Type', 'image/png');
    const emptyTile = await sharp({
      create: {
        width: tileSize,
        height: tileSize,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 }
      }
    })
    .png()
    .toBuffer();
    
    return res.send(emptyTile);
  };
  
  const startTime = Date.now();
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  
  console.log(`[${new Date().toISOString()}] Requisição de tile: z=${z}, x=${x}, y=${y}`);
  
  try {
    const { dataset, info } = initGdalDataset();
    
    // Verificar se o dataset foi inicializado corretamente
    if (!dataset || !info) {
      console.error('Dataset não inicializado corretamente');
      return sendEmptyTile();
    }
    
    console.log(`[${new Date().toISOString()}] Processando tile z=${z}, x=${x}, y=${y}`);

    // Verificar se o tile já está em cache
    const cacheKey = `${z}_${x}_${y}`;
    if (tileCache.has(cacheKey)) {
      const cachedTile = tileCache.get(cacheKey);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'HIT');
      return res.send(cachedTile);
    }
    
    // Definir as projeções
    // Obter a projeção do GeoTIFF
    const tifProjection = info.projection || '+proj=utm +zone=22 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
    
    // Função para converter coordenadas do tile para coordenadas geográficas (WGS84)
    function tileToLatLon(x, y, z) {
      const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
      return {
        lon: x / Math.pow(2, z) * 360 - 180,
        lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
      };
    }
    
    // Calcular as coordenadas geográficas dos cantos do tile
    const nw = tileToLatLon(x, y, z);
    const ne = tileToLatLon(x + 1, y, z);
    const sw = tileToLatLon(x, y + 1, z);
    const se = tileToLatLon(x + 1, y + 1, z);
    
    console.log('Coordenadas WGS84 do tile:', { nw, ne, sw, se });
    
    // Converter para a projeção do GeoTIFF
    try {
      const nwProj = proj4('EPSG:4326', tifProjection, [nw.lon, nw.lat]);
      const neProj = proj4('EPSG:4326', tifProjection, [ne.lon, ne.lat]);
      const swProj = proj4('EPSG:4326', tifProjection, [sw.lon, sw.lat]);
      const seProj = proj4('EPSG:4326', tifProjection, [se.lon, se.lat]);
      
      console.log('Coordenadas projetadas do tile:', { 
        nw: nwProj, 
        ne: neProj, 
        sw: swProj, 
        se: seProj 
      });
      
      // Converter de coordenadas projetadas para pixels usando a transformação geográfica
      const [originX, pixelWidth, skewX, originY, skewY, pixelHeight] = dataset.geoTransform;
      
      // Função para converter coordenadas projetadas para pixels
      function projToPixel(projX, projY) {
        const pixelX = Math.round((projX - originX) / pixelWidth);
        const pixelY = Math.round((projY - originY) / pixelHeight);
        return [pixelX, pixelY];
      }
      
      const nwPixel = projToPixel(nwProj[0], nwProj[1]);
      const nePixel = projToPixel(neProj[0], neProj[1]);
      const swPixel = projToPixel(swProj[0], swProj[1]);
      const sePixel = projToPixel(seProj[0], seProj[1]);
      
      console.log('Coordenadas em pixels do tile:', {
        nw: nwPixel,
        ne: nePixel,
        sw: swPixel,
        se: sePixel
      });
      
      // Calcular os limites do recorte
      const minX = Math.min(nwPixel[0], nePixel[0], swPixel[0], sePixel[0]);
      const maxX = Math.max(nwPixel[0], nePixel[0], swPixel[0], sePixel[0]);
      const minY = Math.min(nwPixel[1], nePixel[1], swPixel[1], sePixel[1]);
      const maxY = Math.max(nwPixel[1], nePixel[1], swPixel[1], sePixel[1]);
      
      const readX = minX;
      const readY = minY;
      const readWidth = maxX - minX;
      const readHeight = maxY - minY;
      
      console.log('Área de recorte calculada:', {
        x: readX,
        y: readY,
        width: readWidth,
        height: readHeight
      });
      
      // Verificar se a área está dentro dos limites do GeoTIFF
      const width = info.width;
      const height = info.height;
      
      if (readX < 0 || readY < 0 || readX >= width || readY >= height || 
          readWidth <= 0 || readHeight <= 0) {
        console.log(`[${new Date().toISOString()}] Área fora dos limites:`);
        console.log(`- Área: x=${readX}, y=${readY}, width=${readWidth}, height=${readHeight}`);
        console.log(`- Limites: width=${width}, height=${height}`);
        return sendEmptyTile();
      }
      
      // Verificar se a área é muito grande (pode indicar um problema de projeção)
      if (readWidth > width * 0.5 || readHeight > height * 0.5) {
        console.log(`[${new Date().toISOString()}] Área muito grande, possível problema de projeção:`);
        console.log(`- Área: x=${readX}, y=${readY}, width=${readWidth}, height=${readHeight}`);
        console.log(`- Limites: width=${width}, height=${height}`);
        
        // Em vez de retornar vazio, vamos tentar um método alternativo para zoom altos
        if (z >= 14) {
          // Para zooms altos, vamos tentar uma abordagem mais direta
          // Calcular o centro do tile em coordenadas geográficas
          const centerLon = (nw.lon + se.lon) / 2;
          const centerLat = (nw.lat + se.lat) / 2;
          
          // Converter para coordenadas projetadas
          const centerProj = proj4('EPSG:4326', tifProjection, [centerLon, centerLat]);
          
          // Converter para pixels
          const centerPixel = projToPixel(centerProj[0], centerProj[1]);
          
          // Definir uma área fixa em torno do centro
          const fixedSize = Math.min(width, height) / 10; // 10% da dimensão menor
          const fixedReadX = Math.max(0, centerPixel[0] - fixedSize / 2);
          const fixedReadY = Math.max(0, centerPixel[1] - fixedSize / 2);
          const fixedReadWidth = Math.min(width - fixedReadX, fixedSize);
          const fixedReadHeight = Math.min(height - fixedReadY, fixedSize);
          
          console.log('Usando área fixa em torno do centro:', {
            x: fixedReadX,
            y: fixedReadY,
            width: fixedReadWidth,
            height: fixedReadHeight
          });
          
          // Verificar se a área fixa é válida
          if (fixedReadWidth <= 0 || fixedReadHeight <= 0) {
            return sendEmptyTile();
          }
          
          // Usar a área fixa
          const adjustedReadX = Math.round(fixedReadX);
          const adjustedReadY = Math.round(fixedReadY);
          const adjustedReadWidth = Math.round(fixedReadWidth);
          const adjustedReadHeight = Math.round(fixedReadHeight);
          
          // Obter as bandas do GeoTIFF
          const [band1, band2, band3] = [1, 2, 3].map(i => dataset.bands.get(i));
          
          // Ler os dados das bandas
          const data1 = await band1.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
          const data2 = await band2.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
          const data3 = await band3.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
          
          // Criar buffer RGB
          const rgbData = Buffer.alloc(adjustedReadWidth * adjustedReadHeight * 3);
          for (let i = 0; i < adjustedReadWidth * adjustedReadHeight; i++) {
            rgbData[i * 3] = data1[i];
            rgbData[i * 3 + 1] = data2[i];
            rgbData[i * 3 + 2] = data3[i];
          }
          
          // Processar a imagem com sharp
          const tileBuffer = await sharp(rgbData, {
            raw: {
              width: adjustedReadWidth,
              height: adjustedReadHeight,
              channels: 3
            }
          })
          .resize(tileSize, tileSize, {
            fit: 'fill',
            position: 'center',
            kernel: 'lanczos3'
          })
          .gamma(1.1)
          .normalize()
          .modulate({
            brightness: 1.1,
            saturation: 1.2
          })
          .png({
            quality: 90,
            compressionLevel: 9
          })
          .toBuffer();
          
          // Armazenar no cache
          tileCache.set(cacheKey, tileBuffer);
          
          // Enviar o tile
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('X-Cache', 'MISS');
          res.send(tileBuffer);
          
          console.log(`[${new Date().toISOString()}] Tile processado (método alternativo) em ${Date.now() - startTime}ms`);
          return;
        }
        
        return sendEmptyTile();
      }
      
      // Ajustar as dimensões para evitar problemas de borda
      const adjustedReadX = Math.max(0, readX);
      const adjustedReadY = Math.max(0, readY);
      const adjustedReadWidth = Math.min(width - adjustedReadX, readWidth);
      const adjustedReadHeight = Math.min(height - adjustedReadY, readHeight);
      
      // Verificar se as dimensões ajustadas são válidas
      if (adjustedReadWidth <= 0 || adjustedReadHeight <= 0) {
        console.log(`[${new Date().toISOString()}] Dimensões ajustadas inválidas:`);
        console.log(`- Dimensões: width=${adjustedReadWidth}, height=${adjustedReadHeight}`);
        return sendEmptyTile();
      }
      
      console.log('Área de recorte ajustada:', {
        x: adjustedReadX,
        y: adjustedReadY,
        width: adjustedReadWidth,
        height: adjustedReadHeight
      });
      
      // Obter as bandas do GeoTIFF
      const [band1, band2, band3] = [1, 2, 3].map(i => dataset.bands.get(i));
      
      // Ler os dados das bandas
      const data1 = await band1.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
      const data2 = await band2.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
      const data3 = await band3.pixels.read(adjustedReadX, adjustedReadY, adjustedReadWidth, adjustedReadHeight);
      
      // Criar buffer RGB
      const rgbData = Buffer.alloc(adjustedReadWidth * adjustedReadHeight * 3);
      for (let i = 0; i < adjustedReadWidth * adjustedReadHeight; i++) {
        rgbData[i * 3] = data1[i];
        rgbData[i * 3 + 1] = data2[i];
        rgbData[i * 3 + 2] = data3[i];
      }
      
      // Processar a imagem com sharp
      const tileBuffer = await sharp(rgbData, {
        raw: {
          width: adjustedReadWidth,
          height: adjustedReadHeight,
          channels: 3
        }
      })
      .resize(tileSize, tileSize, {
        fit: 'fill',
        position: 'center',
        kernel: 'lanczos3'
      })
      .gamma(1.1)
      .normalize()
      .modulate({
        brightness: 1.1,
        saturation: 1.2
      })
      .png({
        quality: 90,
        compressionLevel: 9
      })
      .toBuffer();
      
      // Armazenar no cache
      tileCache.set(cacheKey, tileBuffer);
      
      // Limitar o tamanho do cache (manter apenas os últimos 1000 tiles)
      if (tileCache.size > 1000) {
        const firstKey = tileCache.keys().next().value;
        tileCache.delete(firstKey);
      }
      
      // Enviar o tile
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'MISS');
      res.send(tileBuffer);
      
      console.log(`[${new Date().toISOString()}] Tile processado em ${Date.now() - startTime}ms`);
      
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Erro na transformação de coordenadas:`, error);
      return sendEmptyTile();
    }
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao gerar tile:`, error);
    return sendEmptyTile();
  }
});

// Adicionar uma rota para visualizar o mapa completo em baixa resolução
app.get('/api/preview', async (req, res) => {
  try {
    const { dataset, info } = initGdalDataset();
    const width = info.width;
    const height = info.height;
    
    // Definir uma resolução máxima para a prévia
    const maxPreviewSize = 1024;
    const scale = Math.min(maxPreviewSize / width, maxPreviewSize / height);
    const previewWidth = Math.round(width * scale);
    const previewHeight = Math.round(height * scale);
    
    // Ler as bandas
    const [band1, band2, band3] = [1, 2, 3].map(i => dataset.bands.get(i));
    const data1 = await band1.pixels.read(0, 0, width, height);
    const data2 = await band2.pixels.read(0, 0, width, height);
    const data3 = await band3.pixels.read(0, 0, width, height);
    
    // Criar buffer RGB
    const rgbData = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgbData[i * 3] = data1[i];
      rgbData[i * 3 + 1] = data2[i];
      rgbData[i * 3 + 2] = data3[i];
    }
    
    // Processar a imagem com sharp
    const previewBuffer = await sharp(rgbData, {
      raw: {
        width,
        height,
        channels: 3
      }
    })
    .resize(previewWidth, previewHeight, {
      fit: 'inside',
      kernel: 'lanczos3'
    })
    .gamma(1.1)
    .normalize()
    .modulate({
      brightness: 1.1,
      saturation: 1.2
    })
    .png({
      quality: 90,
      compressionLevel: 9
    })
    .toBuffer();
    
    res.setHeader('Content-Type', 'image/png');
    res.send(previewBuffer);
    
  } catch (error) {
    console.error('Erro ao gerar prévia:', error);
    res.status(500).json({ error: 'Erro ao gerar prévia' });
  }
});

// Rota para verificar informações do arquivo TIF
app.get('/api/tif-info-detailed', (req, res) => {
  const tifPath = path.join(dataPath, 'Iturama-2019.tif');

  if (fs.existsSync(tifPath)) {
    try {
      const dataset = gdal.open(tifPath);
      const info = {
        size: {
          width: dataset.rasterSize.x,
          height: dataset.rasterSize.y
        },
        bands: dataset.bands.count(),
        srs: dataset.srs ? dataset.srs.toWKT() : null,
        geoTransform: dataset.geoTransform,
        metadata: dataset.getMetadata()
      };
      
      // Calcular os limites geográficos
      const [originX, pixelWidth, skewX, originY, skewY, pixelHeight] = dataset.geoTransform;
      const width = dataset.rasterSize.x;
      const height = dataset.rasterSize.y;
      
      const bounds = {
        minX: originX,
        maxX: originX + width * pixelWidth,
        minY: originY + height * pixelHeight,
        maxY: originY
      };
      
      info.bounds = bounds;
      
      // Tentar obter a projeção como string WKT
      const projection = getSafeProjection(dataset);
      info.projection = projection;
      
      // Converter para WGS84
      if (projection) {
        try {
          const nw = proj4(projection, 'EPSG:4326', [bounds.minX, bounds.maxY]);
          const se = proj4(projection, 'EPSG:4326', [bounds.maxX, bounds.minY]);
          
          info.wgs84Bounds = {
            northwest: { lon: nw[0], lat: nw[1] },
            southeast: { lon: se[0], lat: se[1] }
          };
        } catch (error) {
          console.error('Erro ao converter para WGS84:', error);
        }
      }
      
      dataset.close();
      res.json(info);
    } catch (error) {
      res.status(500).json({
        error: 'Erro ao ler arquivo TIF',
        details: error.message
      });
    }
  } else {
    res.status(404).json({
      error: 'Arquivo TIF não encontrado',
      path: tifPath
    });
  }
});

// Adicionar uma rota para servir uma página HTML simples para visualizar o mapa
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Visualizador de GeoTIFF</title>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.7.1/dist/leaflet.css" />
      <style>
        body, html { margin: 0; padding: 0; height: 100%; }
        #map { width: 100%; height: 100%; }
        .info-panel {
          position: absolute;
          top: 10px;
          right: 10px;
          z-index: 1000;
          background: white;
          padding: 10px;
          border-radius: 5px;
          box-shadow: 0 0 10px rgba(0,0,0,0.2);
          max-width: 300px;
          max-height: 300px;
          overflow: auto;
        }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <div class="info-panel" id="info-panel">Carregando informações...</div>
      
      <script src="https://unpkg.com/leaflet@1.7.1/dist/leaflet.js"></script>
      <script>
        // Inicializar o mapa
        const map = L.map('map').setView([-19.7, -50.2], 12);
        
        // Adicionar camada base do OpenStreetMap
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        
        // Adicionar camada do GeoTIFF
        const tifLayer = L.tileLayer('/api/tiles/{z}/{x}/{y}', {
          minZoom: 10,
          maxZoom: 18,
          tileSize: 256,
          opacity: 0.7
        }).addTo(map);
        
        // Obter informações do GeoTIFF
        fetch('/api/tif-info-detailed')
          .then(response => response.json())
          .then(info => {
            document.getElementById('info-panel').innerHTML = '<h3>Informações do GeoTIFF</h3>' + 
              '<p>Dimensões: ' + info.size.width + ' x ' + info.size.height + '</p>' +
              '<p>Bandas: ' + info.bands + '</p>';
            
            // Se tiver limites em WGS84, ajustar o mapa para eles
            if (info.wgs84Bounds) {
              const nw = info.wgs84Bounds.northwest;
              const se = info.wgs84Bounds.southeast;
              map.fitBounds([
                [nw.lat, nw.lon],
                [se.lat, se.lon]
              ]);
            }
          })
          .catch(error => {
            console.error('Erro ao obter informações:', error);
            document.getElementById('info-panel').innerHTML = '<p>Erro ao carregar informações</p>';
          });
          
        // Adicionar informações de coordenadas
        let lastPosition = null;
        map.on('mousemove', function(e) {
          lastPosition = e.latlng;
          document.getElementById('info-panel').innerHTML = 
            '<h3>Informações do GeoTIFF</h3>' +
            '<p>Coordenadas: ' + e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6) + '</p>';
        });
        
        // Adicionar evento de clique para mostrar o tile atual
        map.on('click', function(e) {
          if (!lastPosition) return;
          
          const zoom = map.getZoom();
          const lat = lastPosition.lat;
          const lng = lastPosition.lng;
          
          // Calcular as coordenadas do tile
          const x = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
          const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
          
          document.getElementById('info-panel').innerHTML += 
            '<p>Tile: z=' + zoom + ', x=' + x + ', y=' + y + '</p>' +
            '<p><a href="/api/tiles/' + zoom + '/' + x + '/' + y + '" target="_blank">Ver Tile</a></p>';
        });
      </script>
    </body>
    </html>
  `);
});

// Rota para servir arquivos estáticos (se necessário)
app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`Servidor backend rodando em http://localhost:${port}`);
  console.log(`Servindo dados de: ${dataPath}`);
  
  // Tentar inicializar o dataset no início para detectar problemas
  try {
    initGdalDataset();
    console.log('Dataset GDAL inicializado com sucesso');
  } catch (error) {
    console.error('Erro ao inicializar dataset GDAL:', error);
  }
});