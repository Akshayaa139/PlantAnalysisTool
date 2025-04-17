require("dotenv").config();
const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const port = process.env.PORT || 5000;

// Configure multer
const upload = multer({ dest: "uploads/" }); // Changed to 'uploads' for better practice
app.use(express.json({ limit: "50mb" })); // Increased limit for base64 images

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
app.use(express.static("public"));

// Improved response parser
function parseGeminiResponse(text) {
  try {
    // Remove all markdown code blocks and trim whitespace
    const cleaned = text.replace(/```json|```/g, '').trim();
    // Handle cases where response might have content before/after JSON
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}') + 1;
    const jsonString = cleaned.slice(jsonStart, jsonEnd);
    return JSON.parse(jsonString);
  } catch (e) {
    console.error("Parsing error:", e.message);
    console.error("Original response:", text);
    throw new Error("Failed to parse AI response");
  }
}

// Analysis endpoint
app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded" });
    }

    const imagePath = req.file.path;
    const imageData = await fsPromises.readFile(imagePath, { encoding: "base64" });
    const mimeType = req.file.mimetype;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `
    Analyze this plant image and provide a detailed analysis in JSON format with this exact structure:
    {
      "species": {
        "name": "Scientific and common names",
        "characteristics": "Distinctive features",
        "family": "Plant family",
        "origin": "Native region"
      },
      "health": {
        "status": "Healthy/Unhealthy",
        "issues": ["List any problems"],
        "assessment": "Detailed evaluation"
      },
      "recommendations": {
        "care": ["Care instructions"],
        "treatment": ["Treatment suggestions"],
        "notes": "Additional advice"
      },
      "interesting_facts": "Notable information"
    }
    IMPORTANT: Provide ONLY the raw JSON without any additional text or markdown formatting.
    `;

    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType, data: imageData } }
    ]);

    const responseText = result.response.text();
    console.log("Raw response:", responseText); // Debug logging

    const plantInfo = parseGeminiResponse(responseText);

    // Clean up uploaded file
    await fsPromises.unlink(imagePath);

    res.json({
      success: true,
      species: plantInfo.species || { name: "Unknown", characteristics: "", family: "", origin: "" },
      health: plantInfo.health || { status: "Unknown", issues: [], assessment: "" },
      recommendations: plantInfo.recommendations || { care: [], treatment: [], notes: "" },
      interesting_facts: plantInfo.interesting_facts || "",
      image: `data:${mimeType};base64,${imageData}`
    });

  } catch (error) {
    console.error("Analysis error:", error);
    res.status(500).json({ 
      success: false,
      error: "Plant analysis failed",
      details: error.message
    });
  }
});

// PDF Download endpoint
app.post("/download", express.json(), async (req, res) => {
  try {
    const { species, health, recommendations, interesting_facts, image } = req.body;
    
    // Create reports directory if it doesn't exist
    const reportsDir = path.join(__dirname, "reports");
    await fsPromises.mkdir(reportsDir, { recursive: true });
    
    const filename = `PlantReport_${Date.now()}.pdf`;
    const filePath = path.join(reportsDir, filename);
    
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // PDF Content
    doc.fontSize(25).text("PLANT ANALYSIS REPORT", { align: "center" });
    doc.moveDown();
    doc.fontSize(12).text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(2);

    // Species Section
    doc.fontSize(18).text("1. Species Identification", { underline: true });
    doc.fontSize(12)
       .text(`Name: ${species.name || "Unknown"}`)
       .text(`Family: ${species.family || "Unknown"}`)
       .text(`Origin: ${species.origin || "Unknown"}`);
    doc.moveDown();
    doc.text("Characteristics:", { underline: true });
    doc.text(species.characteristics || "No characteristics identified");
    doc.moveDown(2);

    // Health Section
    doc.fontSize(18).text("2. Health Assessment", { underline: true });
    doc.fontSize(12)
       .text(`Status: ${health.status || "Unknown"}`);
    doc.moveDown();
    doc.text("Issues:", { underline: true });
    health.issues.length > 0 
      ? health.issues.forEach(issue => doc.text(`• ${issue}`))
      : doc.text("No significant issues detected");
    doc.moveDown();
    doc.text("Assessment:", { underline: true });
    doc.text(health.assessment || "No detailed assessment available");
    doc.moveDown(2);

    // Recommendations Section
    doc.fontSize(18).text("3. Care Recommendations", { underline: true });
    doc.fontSize(12).text("Care Instructions:", { underline: true });
    recommendations.care.length > 0
      ? recommendations.care.forEach(item => doc.text(`• ${item}`))
      : doc.text("No specific care instructions");
    doc.moveDown();
    doc.text("Treatment Suggestions:", { underline: true });
    recommendations.treatment.length > 0
      ? recommendations.treatment.forEach(item => doc.text(`• ${item}`))
      : doc.text("No treatments required");
    doc.moveDown();
    doc.text("Additional Notes:", { underline: true });
    doc.text(recommendations.notes || "No additional notes");
    doc.moveDown(2);

    // Interesting Facts
    doc.fontSize(18).text("4. Interesting Facts", { underline: true });
    doc.fontSize(12).text(interesting_facts || "No additional facts available");

    // Add image if available
    if (image) {
      doc.addPage();
      doc.fontSize(16).text("Plant Image", { align: "center" });
      doc.moveDown();
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      const imgBuffer = Buffer.from(base64Data, "base64");
      doc.image(imgBuffer, { 
        fit: [400, 400], 
        align: "center", 
        valign: "center" 
      });
    }

    doc.end();

    // Wait for PDF generation to complete
    await new Promise((resolve) => stream.on("finish", resolve));

    // Send the PDF file
    res.download(filePath, filename, (err) => {
      if (err) console.error("Download error:", err);
      // Attempt to delete the file after sending
      fs.unlink(filePath, (err) => err && console.error("File delete error:", err));
    });

  } catch (error) {
    console.error("PDF generation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to generate report",
      details: error.message
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Uploads directory: ${path.join(__dirname, "uploads")}`);
});