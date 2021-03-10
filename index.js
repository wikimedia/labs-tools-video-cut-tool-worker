const Queue = require('bull');
const superagent = require('superagent');
const fs = require('fs')
const async = require('async');
const utils = require('./utils');
const config = require('./config')();

const API_ROOT = config.API_ROOT;
const PROCESS_VIDEO_QUEUE = 'PROCESS_VIDEO_QUEUE';
const PROCESS_VIDEO_PROGRESS_QUEUE = 'PROCESS_VIDEO_PROGRESS_QUEUE';
const PROCESS_VIDEO_FINISH_QUEUE = 'PROCESS_VIDEO_FINISH_QUEUE';

const REDIS_CONFIG = { host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD }
const processVideoQueue = new Queue(PROCESS_VIDEO_QUEUE, { redis: REDIS_CONFIG });
const processVideoProgressQueue = new Queue(PROCESS_VIDEO_PROGRESS_QUEUE, { redis: REDIS_CONFIG });
const processVideoFinishQueue = new Queue(PROCESS_VIDEO_FINISH_QUEUE, { redis: REDIS_CONFIG });


function updateProgress(videoId, stage) {
    console.log('update progress', videoId, stage)
    processVideoProgressQueue.add({ videoId, stage });
}

processVideoQueue.process(function (job, done) {
    const data = job.data;
    console.log("Received message", data);
    const { settings, ...rest } = job.data;
    processVideo({...settings, ...rest, rotateVideo: settings.rotateValue !== -1}, (err, finalPaths) => {
        if (err) {
            console.log('Error processing video', err);
            processVideoFinishQueue.add({ success: false, videoId: data._id })
        } else {
            // Notify backend that it got finished
            const req = superagent.post(`${API_ROOT}/video_processed`)
                .field('videoId', data._id )
            finalPaths.forEach(filePath => {
                const file = fs.createReadStream(filePath);
                req.attach('videos', file);
            })
            req.then((res) => {
                console.log('done', res.body);
                utils.deleteFiles(finalPaths);
            }).catch(err => {
                console.log('error', err);
                utils.deleteFiles(finalPaths);
                processVideoFinishQueue.add({ success: false, videoId: data.videoId })
            })
        }
        done();
    })
});


function processVideo({ _id, url, videoName, trimVideo, trims, mode, cropVideo, out_width, out_height, x_value, y_value, rotateVideo, rotateValue, disableAudio, }, callback) {
    utils.downloadVideo(url, videoName, (err, videoPath, videoDuration) => {
        if (err || !videoPath || !fs.existsSync(videoPath)) {
            console.log(err);
            return callback('Error downloading video');
        }
        const processFuncArray = [];
        let currentTimecode = 0;
        let endVideoDuration = 0;
        // if the trimVideo is true, this function trims video based on trims array
        // Params: videoPath, trims[]
        if (trimVideo) {
            processFuncArray.push((cb) => {
                console.log('trimming');
                const processNum = trims.length > 1 ? processFuncArray.length - 1 : processFuncArray.length;
                updateProgress(_id, 'trimming')
                utils.trimVideos(videoPath, processNum, trims, mode, (err, videosLocation, newCurrentTimecode) => {
                    utils.deleteFiles([videoPath]);
                    if (err)
                        return cb(err);
                    endVideoDuration = newCurrentTimecode * processFuncArray.length;
                    currentTimecode = newCurrentTimecode;
                    return cb(null, videosLocation);
                });
            });
        }
        else {
            // Just map to an array of paths
            processFuncArray.push((cb) => {
                setTimeout(() => {
                    endVideoDuration = videoDuration * (processFuncArray.length - 1);
                    return cb(null, [videoPath]);
                }, 100);
            });
        }
        // if the rotateVideo is true, this rotates the video to 90 degree clock-wise
        // Params: videoPaths, rotateValue
        if (rotateVideo) {
          processFuncArray.push((videoPaths, cb) => {
              console.log('rotating');
              updateProgress(_id, 'rotating')
              utils.rotateVideos(videoPaths, endVideoDuration, currentTimecode, rotateValue, (err, rotatedVideos, newCurrentTimecode) => {
                  utils.deleteFiles(videoPaths);
                  if (err)
                      return cb(err);
                  currentTimecode = newCurrentTimecode;
                  return cb(null, rotatedVideos);
              });
          });
      }

      // if the CropVideo is true,
        // Params: videoPaths, out_width, out_height, x_value, y_value
        if (cropVideo) {
            processFuncArray.push((videoPaths, cb) => {
                console.log('cropping');
                updateProgress(_id, 'cropping')
                utils.cropVideos(videoPaths, endVideoDuration, currentTimecode, out_width, out_height, x_value, y_value, (err, croppedPaths, newCurrentTimecode) => {
                    utils.deleteFiles(videoPaths);
                    if (err)
                        return cb(err);
                    currentTimecode = newCurrentTimecode;
                    return cb(null, croppedPaths);
                });
            });
        }

        // Based on the video mode, If single this concatinates the trimmed videos into one.
        // Params: videoPaths
        if (mode === "single" && trims.length > 1) {
            processFuncArray.push((videoPaths, cb) => {
                console.log('doing concat');
                updateProgress(_id, 'concating')
                utils.concatVideos(videoPaths, endVideoDuration, currentTimecode, (err, concatedPath, newCurrentTimecode) => {
                    utils.deleteFiles(videoPaths);
                    if (err)
                        return cb(err);
                    currentTimecode = newCurrentTimecode;
                    return cb(null, [concatedPath]);
                });
            });
        }
        // This disables the audio in the video.
        // Params: videoPaths
        if (disableAudio) {
            processFuncArray.push((videoPaths, cb) => {
                console.log('remove audio');
                updateProgress(_id, 'losing audio')
                utils.removeAudioFromVideos(videoPaths, endVideoDuration, currentTimecode, (err, clearedPaths) => {
                    utils.deleteFiles(videoPaths);
                    if (err)
                        return cb(err);
                    return cb(null, clearedPaths);
                });
            });
        }
        processFuncArray.push((videoPaths, cb) => {
            console.log('convert video to supported format(WebM)');
            utils.convertVideoFormat(videoPaths, endVideoDuration, currentTimecode, (err, convertedPaths) => {
                utils.deleteFiles(videoPaths);
                if (err)
                    return cb(err);
                return cb(null, convertedPaths);
            });
        });
        console.log('starting processing');
        // With Async Waterfall method all the required operations will start
        async.waterfall(processFuncArray, (err, result) => {
            console.log(err, result);
            if (err) return callback(err)
            console.log('=================== result ==================');
            return callback(null, result)
        });
    });
}

