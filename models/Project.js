import mongoose from "mongoose";

const ProjectSchema = new mongoose.Schema({
  title: String,
  description: String,
  category: String,
  coverImage: String,
  images: [String],
  mediaType: String,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.models.Project ||
  mongoose.model("Project", ProjectSchema);
