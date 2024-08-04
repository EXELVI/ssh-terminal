const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

function extractFrames(videoPath, outputDir, fps = 1) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(path.join(outputDir, 'frame-%04d.png'))
      .outputOptions('-vf', `fps=${fps}`)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

const asciify = require('asciify-image');

async function convertFrameToAscii(framePath) {
  const options = {
    fit: 'box',
    width: 80,
    height: 40,
  };
  
  return new Promise((resolve, reject) => {
    asciify(framePath, options, (err, ascii) => {
      if (err) reject(err);
      resolve(ascii);
    });
  });
}



const videoPath = 'rick.mp4';
const outputDir = 'frames';

async function main() {
  if (!fs.existsSync(outputDir)){
    fs.mkdirSync(outputDir);
  }

  await extractFrames(videoPath, outputDir, 1); 
  
  const frameFiles = fs.readdirSync(outputDir).filter(file => file.endsWith('.png')).sort();
  
  
  const frames = [];

  for (const file of frameFiles) {
    const framePath = path.join(outputDir, file);
    const asciiFrame = await convertFrameToAscii(framePath);
    console.clear();
    console.log(asciiFrame);
    frames.push(asciiFrame);

    await new Promise(resolve => setTimeout(resolve, 1000 / 24));
  }

  fs.writeFileSync('frames.txt', JSON.stringify(frames));
  
}

main().catch(console.error);
