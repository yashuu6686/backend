

require("dotenv").config();
const express = require('express');

const multer = require('multer');
const cors = require('cors');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const sharp = require('sharp'); // Install: npm install sharp

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());


// MongoDB Connection
mongoose.connect(process.env.MONGO_URI
)
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// Cloudinary Configuration
cloudinary.config({
  cloud_name: 'defmktqyx',
  api_key: '773397374851136',
  api_secret: 'TzrrHMj5zQVh-Yd7SBGS7uUys7Y'
});

// MongoDB Schema
const projectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  category: { type: String, required: true },
  coverImage: { type: String, required: true },
  images: [{ type: String }],
  media: {
    url: String,
    type: String
  },
  likes: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Project = mongoose.model('Project', projectSchema);

// Configure multer with increased size limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // Increased to 20MB for better handling
  },
  fileFilter: (req, file, cb) => {
    const allowedMimetypes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'video/mp4',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska'
    ];

    if (allowedMimetypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

// OPTIMIZED: Compress image before upload
const compressImage = async (buffer, isCover = false) => {
  try {
    // For cover images, maintain higher quality
    // For regular images, compress more aggressively
    const quality = isCover ? 85 : 80;
    const maxWidth = isCover ? 1920 : 1600;

    const compressed = await sharp(buffer)
      .resize(maxWidth, null, {
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality, progressive: true })
      .toBuffer();

    console.log(`Image compressed: ${buffer.length} -> ${compressed.length} bytes`);
    return compressed;
  } catch (error) {
    console.error('Compression error:', error);
    return buffer; // Return original if compression fails
  }
};

// OPTIMIZED: Upload to Cloudinary with minimal transformations
const uploadToCloudinary = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'behance-portfolio',
        resource_type: 'auto',
        // Remove heavy transformations - do them on client side or after upload
        transformation: options.isVideo ? [] : [],
        ...options
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result.secure_url);
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

// Upload fields configuration
const uploadFields = upload.fields([
  { name: "coverImage", maxCount: 1 },
  { name: "images", maxCount: 15 },
  { name: "media", maxCount: 1 }
]);

// OPTIMIZED: CREATE - Add new project with parallel uploads
app.post("/api/projects", uploadFields, async (req, res) => {
  try {
    const { title, description, category } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: "Title and category are required" });
    }

    if (!req.files?.coverImage) {
      return res.status(400).json({ error: "Cover image is required" });
    }

    console.log('Starting upload process...');
    const startTime = Date.now();

    // OPTIMIZED: Compress and upload cover image
    const compressedCover = await compressImage(req.files.coverImage[0].buffer, true);
    const coverImageUrl = await uploadToCloudinary(
      compressedCover,
      { public_id: `cover-${Date.now()}` }
    );
    // console.log(`Cover image uploaded in ${Date.now() - startTime}ms`);

    // OPTIMIZED: Compress and upload all images in PARALLEL
    let imagesUrls = [];
    if (req.files.images) {
      // console.log(`Compressing ${req.files.images.length} images...`);
      
      // Compress all images in parallel
      const compressionPromises = req.files.images.map(file => 
        compressImage(file.buffer, false)
      );
      const compressedImages = await Promise.all(compressionPromises);
      
      // console.log('All images compressed, uploading to Cloudinary...');
      
      // Upload all compressed images in parallel
      const uploadPromises = compressedImages.map((buffer, index) => 
        uploadToCloudinary(buffer, { 
          public_id: `image-${Date.now()}-${index}` 
        })
      );
      
      imagesUrls = await Promise.all(uploadPromises);
      // console.log(`All images uploaded in ${Date.now() - startTime}ms`);
    }

    // Upload media (video) - no compression for videos
    let media = null;
    if (req.files.media) {
      const file = req.files.media[0];
      const isVideo = file.mimetype.startsWith('video');
      
      const mediaUrl = await uploadToCloudinary(
        file.buffer,
        { 
          public_id: `media-${Date.now()}`,
          resource_type: isVideo ? 'video' : 'image',
          isVideo
        }
      );

      media = {
        url: mediaUrl,
        type: isVideo ? 'video' : 'image'
      };
    }

    // Create project in MongoDB
    const project = new Project({
      title,
      description: description || '',
      category,
      coverImage: coverImageUrl,
      images: imagesUrls,
      media,
      likes: Math.floor(Math.random() * 500),
      views: Math.floor(Math.random() * 2000),
      comments: Math.floor(Math.random() * 50)
    });

    await project.save();

    const totalTime = Date.now() - startTime;
    // console.log(`✅ Project created successfully in ${totalTime}ms`);

    res.status(201).json({
      message: "Project created successfully",
      uploadTime: `${totalTime}ms`,
      project: {
        ...project.toObject(),
        coverImageUrl: project.coverImage,
        imagesUrls: project.images,
        mediaUrl: project.media?.url || null
      }
    });

  } catch (error) {
    console.error("Error creating project:", error);
    res.status(500).json({ error: error.message });
  }
});

// READ - Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    const { category } = req.query;
    
    let query = {};
    if (category) {
      query.category = category;
    }

    const projects = await Project.find(query).sort({ createdAt: -1 });

    const projectsWithUrls = projects.map(project => ({
      ...project.toObject(),
      id: project._id,
      coverImageUrl: project.coverImage,
      imagesUrls: project.images,
      mediaUrl: project.media?.url || null
    }));

    res.json({ 
      count: projectsWithUrls.length,
      projects: projectsWithUrls 
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// READ - Get single project by ID
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      ...project.toObject(),
      id: project._id,
      coverImageUrl: project.coverImage,
      imagesUrls: project.images,
      mediaUrl: project.media?.url || null
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ error: error.message });
  }
});

// OPTIMIZED: UPDATE - Update project with parallel uploads
app.put('/api/projects/:id', uploadFields, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { title, description, category } = req.body;

    // Update text fields
    if (title) project.title = title;
    if (description !== undefined) project.description = description;
    if (category) project.category = category;

    // Update cover image if provided
    if (req.files?.coverImage) {
      const compressedCover = await compressImage(req.files.coverImage[0].buffer, true);
      const coverImageUrl = await uploadToCloudinary(
        compressedCover,
        { public_id: `cover-${Date.now()}` }
      );
      project.coverImage = coverImageUrl;
    }

    // Update additional images if provided (parallel upload)
    if (req.files?.images) {
      const compressionPromises = req.files.images.map(file => 
        compressImage(file.buffer, false)
      );
      const compressedImages = await Promise.all(compressionPromises);
      
      const uploadPromises = compressedImages.map((buffer, index) => 
        uploadToCloudinary(buffer, { 
          public_id: `image-${Date.now()}-${index}` 
        })
      );
      
      const imagesUrls = await Promise.all(uploadPromises);
      project.images = imagesUrls;
    }

    // Update media if provided
    if (req.files?.media) {
      const file = req.files.media[0];
      const isVideo = file.mimetype.startsWith('video');
      
      const mediaUrl = await uploadToCloudinary(
        file.buffer,
        { 
          public_id: `media-${Date.now()}`,
          resource_type: isVideo ? 'video' : 'image',
          isVideo
        }
      );

      project.media = {
        url: mediaUrl,
        type: isVideo ? 'video' : 'image'
      };
    }

    project.updatedAt = new Date();
    await project.save();

    res.json({
      message: 'Project updated successfully',
      project: {
        ...project.toObject(),
        id: project._id,
        coverImageUrl: project.coverImage,
        imagesUrls: project.images,
        mediaUrl: project.media?.url || null
      }
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE - Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get available categories
app.get('/api/categories', (req, res) => {
  const categories = [
    { value: 'graphic-design', label: 'Graphic Design' },
    { value: 'video-edits', label: 'Video Edits' },
    { value: 'photography', label: 'Photography' }
  ];
  res.json({ categories });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Server is running', 
    port: PORT,
    mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
    cloudinary: 'Configured'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum 20MB allowed.' });
    }
    return res.status(400).json({ error: error.message });
  }
  
  res.status(500).json({ error: error.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  // console.log(`📦 MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}`);
console.log("URL",process.env.MONGO_URI);

  console.log(`☁️  Cloudinary: Configured`);
  console.log(`✅ Server ready to accept requests`);
});