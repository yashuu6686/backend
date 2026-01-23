require("dotenv").config();
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const sharp = require('sharp');
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const nodemailer = require("nodemailer");
const axios = require("axios"); // Added axios as it was used but not imported



const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 5000;

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  upload_timeout: 600000,
  timeout: 600000
});


app.use((req, res, next) => {
  req.setTimeout(15 * 60 * 1000); // 15 minutes
  res.setTimeout(15 * 60 * 1000);
  next();
});






const compressVideo = async (inputBuffer) => {
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input-${Date.now()}.mp4`);
  const outputPath = path.join(tempDir, `output-${Date.now()}.mp4`);

  try {
    await fs.writeFile(inputPath, inputBuffer);

    console.log("⚙️ Starting aggressive video compression...");

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Video compression timeout (5 minutes)"));
      }, 5 * 60 * 1000);

      ffmpeg(inputPath)
        .outputOptions([
          "-vcodec libx264",
          "-crf 32", // More aggressive compression (was 28)
          "-preset ultrafast", // Faster encoding
          "-movflags +faststart",
          "-vf scale='min(960,iw):-2'", // Smaller resolution (was 1280)
          "-r 24", // Reduce framerate to 24fps
          "-maxrate 1M", // Lower bitrate
          "-bufsize 2M",
          "-an" // Remove audio if not needed (optional)
        ])
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(`📊 Compression: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", async () => {
          clearTimeout(timeout);
          try {
            const compressed = await fs.readFile(outputPath);
            const originalSize = inputBuffer.length / 1024 / 1024;
            const compressedSize = compressed.length / 1024 / 1024;
            console.log(`✅ Compressed: ${originalSize.toFixed(2)}MB → ${compressedSize.toFixed(2)}MB (${((1 - compressedSize / originalSize) * 100).toFixed(1)}% reduction)`);
            resolve(compressed);
          } catch (err) {
            reject(err);
          }
        })
        .on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        })
        .save(outputPath);
    });
  } finally {
    try {
      await fs.unlink(inputPath).catch(() => { });
      await fs.unlink(outputPath).catch(() => { });
    } catch (err) {
      console.error("Temp file cleanup error:", err);
    }
  }
};

// ============= ADMIN AUTH MIDDLEWARE =============
const authenticateAdmin = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ============= ADMIN ROUTES =============

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      const token = jwt.sign(
        { username, role: 'admin' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        message: 'Login successful',
        token,
        admin: { username }
      });
    }

    res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify Token
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  res.json({ valid: true, admin: req.admin });
});

// MongoDB Schema
const mediaSchema = new mongoose.Schema({
  url: { type: String },
  mediaType: { type: String },  // Changed from 'type' to 'mediaType'
  duration: { type: Number }, // video duration in seconds
  format: { type: String } // file format
}, { _id: false });

// MongoDB Schema - Project Schema
const projectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  category: { type: String, required: true },
  coverImage: { type: String, required: true },
  images: [{ type: String }],
  media: { type: mediaSchema, default: null },
  likes: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Project = mongoose.model('Project', projectSchema);

// Configure multer with increased video limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB for videos
  },
  fileFilter: (req, file, cb) => {
    const allowedMimetypes = [
      // Images
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      // Videos
      'video/mp4',
      'video/quicktime', // .mov
      'video/x-msvideo', // .avi
      'video/x-matroska', // .mkv
      'video/webm',
      'video/x-flv',
      'video/mpeg'
    ];

    if (allowedMimetypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}. Supported formats: Images (JPEG, PNG, GIF, WebP, SVG) and Videos (MP4, MOV, AVI, MKV, WebM)`));
    }
  },
});

// Compress image
const compressImage = async (buffer, isCover = false) => {
  try {
    const quality = isCover ? 85 : 80;
    const maxWidth = isCover ? 1920 : 1600;

    const compressed = await sharp(buffer)
      .resize(maxWidth, null, {
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality, progressive: true })
      .toBuffer();

    console.log(`✅ Image compressed: ${(buffer.length / 1024 / 1024).toFixed(2)}MB → ${(compressed.length / 1024 / 1024).toFixed(2)}MB`);
    return compressed;
  } catch (error) {
    console.error('❌ Compression error:', error);
    return buffer;
  }
};

const uploadToCloudinaryDirect = async (buffer, options = {}) => {
  const isVideo = options.resource_type === 'video';

  try {
    console.log(`☁️ Uploading to Cloudinary via direct API...`);

    // Generate signature
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = {
      timestamp,
      folder: options.folder || 'behance-portfolio',
      public_id: options.public_id
    };

    if (isVideo) {
      paramsToSign.resource_type = 'video';
      paramsToSign.eager = 'w_960,h_540,c_limit,q_auto:low/mp4';
      paramsToSign.eager_async = true;
    }

    // Create signature string
    const signatureString = Object.keys(paramsToSign)
      .sort()
      .map(key => `${key}=${paramsToSign[key]}`)
      .join('&');

    const crypto = require('crypto');
    const signature = crypto
      .createHash('sha256')
      .update(signatureString + process.env.CLOUDINARY_API_SECRET)
      .digest('hex');

    // Prepare form data
    const FormData = require('form-data');
    const form = new FormData();

    form.append('file', buffer, {
      filename: `upload.${isVideo ? 'mp4' : 'jpg'}`,
      contentType: isVideo ? 'video/mp4' : 'image/jpeg'
    });
    form.append('timestamp', timestamp);
    form.append('folder', paramsToSign.folder);
    form.append('public_id', paramsToSign.public_id);
    form.append('api_key', process.env.CLOUDINARY_API_KEY);
    form.append('signature', signature);

    if (isVideo) {
      form.append('resource_type', 'video');
      form.append('eager', 'w_960,h_540,c_limit,q_auto:low/mp4');
      form.append('eager_async', 'true');
    }

    const uploadUrl = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${isVideo ? 'video' : 'image'}/upload`;

    const response = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000, // 10 minutes
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        console.log(`📤 Upload progress: ${percentCompleted}%`);
      }
    });

    console.log(`✅ Upload complete: ${response.data.secure_url}`);

    return {
      url: response.data.secure_url,
      duration: response.data.duration,
      format: response.data.format
    };

  } catch (error) {
    console.error('❌ Direct upload error:', error.response?.data || error.message);
    throw error;
  }
};

// Fallback: Upload very large videos to temporary storage first
const uploadLargeVideo = async (buffer, options = {}) => {
  console.log("📦 Using chunked upload for large video...");

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_large(
      buffer,
      {
        resource_type: 'video',
        folder: options.folder || 'behance-portfolio',
        public_id: options.public_id,
        chunk_size: 20000000, // 20MB chunks
        eager: 'w_960,h_540,c_limit,q_auto:low/mp4',
        eager_async: true,
        timeout: 600000
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve({
            url: result.secure_url,
            duration: result.duration,
            format: result.format
          });
        }
      }
    );
  });
};


const uploadToCloudinary = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const isVideo = options.resource_type === 'video';
    const sizeMB = buffer.length / 1024 / 1024;

    console.log(`📊 Uploading ${sizeMB.toFixed(2)}MB ${isVideo ? 'video' : 'image'}...`);

    const uploadOptions = {
      folder: 'behance-portfolio',
      resource_type: options.resource_type || 'auto',
      timeout: 600000,
      chunk_size: 6000000,
      ...options
    };

    // Add video-specific optimizations
    if (isVideo) {
      uploadOptions.eager = 'w_960,h_540,c_limit,q_auto:low/mp4';
      uploadOptions.eager_async = true;
      uploadOptions.quality = 'auto:low';
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('❌ Cloudinary error:', error.message);
          reject(error);
        } else {
          console.log(`✅ Upload complete: ${result.secure_url}`);
          resolve({
            url: result.secure_url,
            duration: result.duration,
            format: result.format
          });
        }
      }
    );

    // Stream the buffer to Cloudinary
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};


const uploadFields = upload.fields([
  { name: "coverImage", maxCount: 1 },
  { name: "images", maxCount: 15 },
  { name: "media", maxCount: 1 } // Can be video or image
]);

// ============= PROJECT ROUTES =============

// CREATE - Add new project (ADMIN ONLY)

// CREATE endpoint - simplified video handling
app.post("/api/projects", authenticateAdmin, uploadFields, async (req, res) => {
  try {
    const { title, description, category } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: "Title and category are required" });
    }

    if (!req.files?.coverImage) {
      return res.status(400).json({ error: "Cover image is required" });
    }

    console.log('🚀 Starting upload process...');
    const startTime = Date.now();

    // Upload cover image
    const compressedCover = await compressImage(req.files.coverImage[0].buffer, true);
    const coverImageResult = await uploadToCloudinary(
      compressedCover,
      {
        public_id: `cover-${Date.now()}`,
        resource_type: 'image'
      }
    );

    // Upload additional images
    let imagesUrls = [];
    if (req.files.images) {
      console.log(`📸 Uploading ${req.files.images.length} additional images...`);
      const compressionPromises = req.files.images.map(file =>
        compressImage(file.buffer, false)
      );
      const compressedImages = await Promise.all(compressionPromises);

      const uploadPromises = compressedImages.map((buffer, index) =>
        uploadToCloudinary(buffer, {
          public_id: `image-${Date.now()}-${index}`,
          resource_type: 'image'
        })
      );

      const results = await Promise.all(uploadPromises);
      imagesUrls = results.map(r => r.url);
    }

    // Upload media (video or image)
    let media = null;
    if (req.files.media) {
      const file = req.files.media[0];
      const isVideo = file.mimetype.startsWith('video');
      const fileSizeMB = file.size / 1024 / 1024;

      console.log('📋 Media File:', {
        size: `${fileSizeMB.toFixed(2)}MB`,
        type: file.mimetype
      });

      if (isVideo && fileSizeMB > 100) {
        return res.status(400).json({
          error: `Video too large: ${fileSizeMB.toFixed(2)}MB. Max 100MB.`
        });
      }

      let finalBuffer = file.buffer;

      // Compress videos larger than 20MB
      if (isVideo && fileSizeMB > 20) {
        try {
          console.log("🔧 Compressing video...");
          finalBuffer = await compressVideo(file.buffer);

          const compressedSizeMB = finalBuffer.length / 1024 / 1024;
          console.log(`✅ Video ready: ${compressedSizeMB.toFixed(2)}MB`);

          // If still too large, reject
          if (compressedSizeMB > 40) {
            return res.status(400).json({
              error: `Video still too large after compression (${compressedSizeMB.toFixed(2)}MB). Please use a shorter video.`
            });
          }
        } catch (compressionError) {
          console.error("❌ Compression failed:", compressionError.message);
          return res.status(500).json({
            error: "Video compression failed. Try a different format."
          });
        }
      } else if (isVideo) {
        console.log("📤 Video small enough, uploading directly...");
      }

      // Upload to Cloudinary
      try {
        const mediaResult = await uploadToCloudinary(
          finalBuffer,
          {
            public_id: `media-${Date.now()}`,
            resource_type: isVideo ? 'video' : 'image'
          }
        );

        media = {
          url: mediaResult.url,
          mediaType: isVideo ? 'video' : 'image',
          duration: mediaResult.duration,
          format: mediaResult.format
        };

      } catch (uploadError) {
        console.error("❌ Upload failed:", uploadError.message);

        // Provide helpful error messages
        if (uploadError.message?.includes('502')) {
          return res.status(500).json({
            error: "Cloudinary service timeout. The video may be too large.",
            suggestion: "Try compressing the video further or use a shorter clip"
          });
        }

        if (uploadError.message?.includes('ECONNRESET')) {
          return res.status(500).json({
            error: "Connection lost during upload.",
            suggestion: "This usually means the file is too large. Try a smaller/shorter video"
          });
        }

        return res.status(500).json({
          error: "Upload failed: " + uploadError.message,
          suggestion: "Try a smaller file or different format"
        });
      }
    }

    // Create project
    const project = new Project({
      title,
      description: description || '',
      category,
      coverImage: coverImageResult.url,
      images: imagesUrls,
      media,
      likes: Math.floor(Math.random() * 500),
      views: Math.floor(Math.random() * 2000),
      comments: Math.floor(Math.random() * 50)
    });

    await project.save();

    const totalTime = Date.now() - startTime;
    console.log(`✅ Project created in ${(totalTime / 1000).toFixed(2)}s`);

    res.status(201).json({
      message: "Project created successfully",
      uploadTime: `${(totalTime / 1000).toFixed(2)}s`,
      project: {
        ...project.toObject(),
        id: project._id,
        coverImageUrl: project.coverImage,
        imagesUrls: project.images,
        mediaUrl: media?.url || null,
        mediaType: media?.mediaType || null
      }
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({
      error: error.message || "Failed to create project"
    });
  }
});

// READ - Get all projects (PUBLIC)
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
      mediaUrl: project.media?.url || null,
      mediaType: project.media?.mediaType || null,
      mediaDuration: project.media?.duration || null
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

// READ - Get single project by ID (PUBLIC)
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
      mediaUrl: project.media?.url || null,
      mediaType: project.media?.mediaType || null,
      mediaDuration: project.media?.duration || null
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ error: error.message });
  }
});

// UPDATE - Update project (ADMIN ONLY)
app.put('/api/projects/:id', authenticateAdmin, uploadFields, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { title, description, category } = req.body;

    if (title) project.title = title;
    if (description !== undefined) project.description = description;
    if (category) project.category = category;

    // Update cover image
    if (req.files?.coverImage) {
      const compressedCover = await compressImage(req.files.coverImage[0].buffer, true);
      const coverImageResult = await uploadToCloudinary(
        compressedCover,
        {
          public_id: `cover-${Date.now()}`,
          resource_type: 'image'
        }
      );
      project.coverImage = coverImageResult.url;
    }

    // Update images
    if (req.files?.images) {
      const compressionPromises = req.files.images.map(file =>
        compressImage(file.buffer, false)
      );
      const compressedImages = await Promise.all(compressionPromises);

      const uploadPromises = compressedImages.map((buffer, index) =>
        uploadToCloudinary(buffer, {
          public_id: `image-${Date.now()}-${index}`,
          resource_type: 'image'
        })
      );

      const results = await Promise.all(uploadPromises);
      project.images = results.map(r => r.url);
    }

    // Update media
    if (req.files?.media) {
      const file = req.files.media[0];
      const isVideo = file.mimetype.startsWith('video');

      const mediaResult = await uploadToCloudinary(
        file.buffer,
        {
          public_id: `media-${Date.now()}`,
          resource_type: isVideo ? 'video' : 'image'
        }
      );

      project.media = {
        url: mediaResult.url,
        mediaType: isVideo ? 'video' : 'image',
        duration: mediaResult.duration,
        format: mediaResult.format
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
        mediaUrl: project.media?.url || null,
        mediaType: project.media?.mediaType || null
      }
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE - Delete project (ADMIN ONLY)
app.delete('/api/projects/:id', authenticateAdmin, async (req, res) => {
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

// ============= CONTACT ROUTES =============

// POST - Send Contact Email
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, project, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email, and message are required" });
    }

    // Configure Nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: email,
      to: process.env.EMAIL_USER,
      subject: `New Inquiry from ${name} - ${project}`,
      text: `
        Name: ${name}
        Email: ${email}
        Project Type: ${project}
        
        Message:
        ${message}
      `,
      html: `
        <h3>New Inquiry from Website</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Project Type:</strong> ${project}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent from ${email}`);

    res.status(200).json({ message: "Email sent successfully!" });
  } catch (error) {
    console.error('❌ Email error:', error);
    res.status(500).json({ error: "Failed to send email. Please try again later." });
  }
});

// Get available categories (PUBLIC)
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
    cloudinary: 'Configured',
    videoSupport: 'Enabled (Max 1000MB)',
    supportedVideoFormats: ['MP4', 'MOV', 'AVI', 'MKV', 'WebM']
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size too large. Maximum 100MB allowed for videos, 20MB for images.' });
    }
    return res.status(400).json({ error: error.message });
  }

  res.status(500).json({ error: error.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📦 MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}`);
  console.log(`☁️  Cloudinary: Configured`);
  console.log(`🎥 Video Upload: Enabled (Max 100MB)`);
  console.log(`🔐 Admin Authentication: Enabled`);
  console.log(`✅ Server ready to accept requests`);
});




// const express = require("express");
// const fs = require("fs");
// const path = require("path");
// const PDFDocument = require("pdfkit");
// const sharp = require("sharp");

// const app = express();
// const PORT = 3000;

// // Logical Order of Operations for the PDF
// const fileOrder = [
//   "diagram-export-1-16-2026-3_26_46-PM.jpg", // BOM
//   "diagram-export-1-16-2026-3_27_39-PM.jpg", // Material Issue
//   "diagram-export-1-16-2026-3_28_51-PM.jpg", // Batch
//   "diagram-export-1-16-2026-3_29_21-PM.jpg", // SOP
//   "diagram-export-1-16-2026-3_30_56-PM.jpg", // After Production Check
//   "diagram-export-1-16-2026-3_33_07-PM.jpg", // Rejected Goods
//   "diagram-export-1-16-2026-3_33_24-PM.jpg", // Final QC
//   "diagram-export-1-16-2026-3_33_40-PM.jpg", // COA
//   "diagram-export-1-16-2026-3_34_39-PM.jpg", // Invoice
//   "diagram-export-1-16-2026-3_35_15-PM.jpg",  // Dispatch
//   "diagram-export-1-16-2026-3_43_58-PM.jpg",
//   "diagram-export-1-16-2026-3_44_17-PM.jpg",
//   "diagram-export-1-16-2026-3_44_31-PM.jpg",
//   "diagram-export-1-16-2026-3_44_43-PM.jpg",
//   "diagram-export-1-16-2026-3_44_56-PM.jpg",
//   "diagram-export-1-16-2026-3_45_20-PM.jpg"
// ];

// app.get("/generate-pdf", async (req, res) => {
//   try {
//     const imagesDir = path.join(__dirname, "images");
//     const outputDir = path.join(__dirname, "output");
//     const outputFile = path.join(outputDir, "Scanbo_ERP_Wireframes.pdf");

//     if (!fs.existsSync(outputDir)) {
//       fs.mkdirSync(outputDir);
//     }

//     const doc = new PDFDocument({ autoFirstPage: false });
//     const stream = fs.createWriteStream(outputFile);
//     doc.pipe(stream);

//     console.log("Processing images...");

//     for (const filename of fileOrder) {
//       const imagePath = path.join(imagesDir, filename);

//       if (!fs.existsSync(imagePath)) {
//         console.log(`Warning: File not found - ${filename}`);
//         continue;
//       }

//       console.log(`Added: ${filename}`);

//       // Convert image to RGB buffer (like PIL .convert("RGB"))
//       const buffer = await sharp(imagePath)
//         .jpeg({ quality: 95 })
//         .toBuffer();

//       const image = doc.openImage(buffer);

//       doc.addPage({
//         size: [image.width, image.height]
//       });

//       doc.image(image, 0, 0);
//     }

//     doc.end();

//     stream.on("finish", () => {
//       console.log("PDF generated successfully!");
//       res.download(outputFile);
//     });

//   } catch (error) {
//     console.error("Error generating PDF:", error);
//     res.status(500).send("Failed to generate PDF");
//   }
// });

// app.listen(PORT, () => {
//   console.log(`Server running at http://localhost:${PORT}`);
// });
