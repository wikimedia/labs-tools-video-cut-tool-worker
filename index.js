const Queue = require('bull');
const superagent = require('superagent');
const fs = require('fs');
const utils = require('./utils');
const config = require('./config')();

const { API_ROOT } = config;
const PROCESS_VIDEO_QUEUE = 'PROCESS_VIDEO_QUEUE';
const PROCESS_VIDEO_PROGRESS_QUEUE = 'PROCESS_VIDEO_PROGRESS_QUEUE';
const PROCESS_VIDEO_FINISH_QUEUE = 'PROCESS_VIDEO_FINISH_QUEUE';

const REDIS_CONFIG = {
	host: config.REDIS_HOST,
	port: config.REDIS_PORT,
	password: config.REDIS_PASSWORD
};

const processVideoQueue = new Queue(PROCESS_VIDEO_QUEUE, { redis: REDIS_CONFIG });
const processVideoProgressQueue = new Queue(PROCESS_VIDEO_PROGRESS_QUEUE, { redis: REDIS_CONFIG });
const processVideoFinishQueue = new Queue(PROCESS_VIDEO_FINISH_QUEUE, { redis: REDIS_CONFIG });

function updateProgress(videoId, stage) {
	console.log('update progress', videoId, stage);
	processVideoProgressQueue.add({ videoId, stage });
}

/**
 *
 * @param {object} settings Setting that control required maniuplations
 * @returns {array|error} Return an array of converted paths or error on failor
 */
async function processVideo(settings) {
	const {
		_id,
		url,
		videoName,
		trimVideo,
		trims,
		mode,
		cropVideo,
		out_width,
		out_height,
		x_value,
		y_value,
		rotateVideo,
		rotateValue,
		disableAudio
	} = settings;

	const videoId = _id;
	const donwloadingVideoInfo = {
		videoName,
		videoId
	};

	updateProgress(_id, 'downloading');
	const { error, videoPath } = await utils.downloadVideo(url, donwloadingVideoInfo);

	if (error || !videoPath || !fs.existsSync(videoPath)) {
		console.error(error);
		return 'Error downloading video';
	}

	// Combine audio disable, rotation and cropping in one command if set
	const manipulations = {};
	if (disableAudio) {
		manipulations.disable_audio = true;
	}
	if (rotateVideo) {
		manipulations.rotate = rotateValue;
	}

	if (cropVideo) {
		manipulations.crop = {
			out_width,
			out_height,
			x_value,
			y_value
		};
	}

	try {
		let newVideoPath = null;
		const hasManipulations = Object.keys(manipulations).length > 0;
		// Manipulate video if audio disable, rotation or cropping is set and trim is not set
		if (hasManipulations && trimVideo !== true) {
			updateProgress(_id, 'manipulations');
			const manipulationsVideoInfo = {
				videoPath,
				videoId
			};
			const manipulateStage = await utils.manipulateVideo(manipulationsVideoInfo, manipulations);
			newVideoPath = manipulateStage.newVideoPath;

			utils.deleteFiles(videoPath);
		}

		// Trim video if set
		if (trimVideo) {
			manipulations.trim = true;
			updateProgress(_id, hasManipulations ? 'manipulations' : 'trimming');

			newVideoPath = newVideoPath || videoPath;
			const trimmingVideoInfo = {
				videoPath: newVideoPath,
				videoId
			};
			const trimStage = await utils.trimVideos(trimmingVideoInfo, trims, manipulations);
			utils.deleteFiles(newVideoPath);
			newVideoPath = trimStage.trimsLocations;

			// Concatnate videos if mode is single
			if (mode === 'single' && trims.length > 1) {
				updateProgress(_id, 'concating');
				const concatingCideoInfo = {
					videoPaths: newVideoPath,
					videoId
				};
				const concatStage = await utils.concatVideos(concatingCideoInfo);
				utils.deleteFiles(newVideoPath);
				newVideoPath = concatStage.concatedLocation;
			}
		}

		// Convert video and return the converted video path
		const convertingVideoInfo = {
			videoPaths: newVideoPath,
			videoId
		};
		return await utils.convertVideoFormat(convertingVideoInfo);
	} catch (manipulationError) {
		console.log('Manipulation Error', manipulationError);
		return error;
	}
}

processVideoQueue.process(async job => {
	const { _id } = job.data;
	const { settings, ...rest } = job.data;
	console.log('Received message', job.data);

	const finalPaths = await processVideo({
		...settings,
		...rest,
		rotateVideo: settings.rotateValue !== 3
	});

	try {
		// Notify backend that it got finished
		const req = superagent.post(`${API_ROOT}/video_processed`).field('videoId', _id);
		finalPaths.forEach(filePath => {
			const file = fs.createReadStream(filePath);
			req.attach('videos', file);
		});
		const repsponse = await req;
		console.log('done', repsponse.body);
		utils.deleteFiles(finalPaths);
	} catch (error) {
		console.log('Error processing video', error);
		utils.deleteFiles(finalPaths);
		processVideoFinishQueue.add({ success: false, videoId: _id });
	}
});
