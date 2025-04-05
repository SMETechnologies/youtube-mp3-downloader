'use strict';
const os = require('os');
const EventEmitter = require('events').EventEmitter;
const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('@distube/ytdl-core');
const async = require('async');
const progress = require('progress-stream');
const sanitize = require('sanitize-filename');
const { HttpsProxyAgent } = require('https-proxy-agent');
const tough = require('tough-cookie');
const { ProxyAgent } = require('undici');
const ProxyRotator = require('./RotatingProxyAgent');

class YoutubeMp3Downloader extends EventEmitter {
  constructor(options) {
    super();
    this.youtubeBaseUrl = 'http://www.youtube.com/watch?v=';
    this.youtubeVideoQuality = options?.youtubeVideoQuality ?? 'highestaudio';
    this.outputPath = options?.outputPath ?? os.homedir();
    this.queueParallelism = options?.queueParallelism ?? 1;
    this.progressTimeout = options?.progressTimeout ?? 1000;
    this.outputOptions = options?.outputOptions ?? [];
    this.allowWebm = options?.allowWebm ?? false;

    // Add cookie jar initialization
    this.cookieJar = new tough.CookieJar();

    // Initialize request options with cookies
    this.requestOptions = {
      ...(options?.requestOptions || {}),
      maxRedirects: options?.requestOptions?.maxRedirects ?? 5,
      headers: {
        ...(options?.requestOptions?.headers || {}),
        Cookie: this.cookieJar.getCookieStringSync('https://www.youtube.com'),
      },
    };

    // Initialize proxy rotator
    this.proxyRotator =
      options?.proxies?.length > 0 ? new ProxyRotator(options.proxies) : null;

    // Set default proxy rotation behavior
    this.rotateProxies = options?.rotateProxies ?? options?.proxies?.length > 0;

    if (options?.ffmpegPath) {
      ffmpeg.setFfmpegPath(options.ffmpegPath);
    }

    this.setupQueue();
  }

  setupQueue() {
    let self = this;
    // Async download/transcode queue
    this.downloadQueue = async.queue(function (task, callback) {
      self.emit(
        'queueSize',
        self.downloadQueue.running() + self.downloadQueue.length()
      );

      self.performDownload(task, function (err, result) {
        callback(err, result);
      });
    }, self.queueParallelism);
  }

  download(videoId, fileName) {
    let self = this;
    const task = {
      videoId: videoId,
      fileName: fileName,
    };

    this.downloadQueue.push(task, function (err, data) {
      self.emit(
        'queueSize',
        self.downloadQueue.running() + self.downloadQueue.length()
      );

      if (err) {
        self.emit('error', err, data);
      } else {
        self.emit('finished', err, data);
      }
    });
  }

  getRequestOptions() {
    // Base options with cookies
    const baseOptions = {
      ...this.requestOptions,
      headers: {
        ...this.requestOptions.headers,
        Cookie: this.cookieJar.getCookieStringSync('https://www.youtube.com'),
      },
    };

    // If no proxies or rotation disabled, return basic options
    if (!this.rotateProxies || !this.proxyRotator) {
      return baseOptions;
    }

    // Get next proxy agent and merge with base options
    const proxyAgent = this.proxyRotator.getNextProxyAgent();
    return {
      ...baseOptions,
      dispatcher: proxyAgent,
    };
  }

  async performDownload(task, callback) {
    const self = this;
    const videoUrl = this.youtubeBaseUrl + task.videoId;
    const resultObj = { videoId: task.videoId };

    try {
      // Get properly configured request options
      const requestOptions = this.getRequestOptions();

      // Get video info with proxy support
      const info = await ytdl.getInfo(videoUrl, {
        quality: this.youtubeVideoQuality,
        requestOptions,
      });

      const videoTitle = sanitize(info.videoDetails.title);
      let artist = 'Unknown';
      let title = 'Unknown';
      const thumbnail =
        info.videoDetails.thumbnails?.[0]?.url ||
        info.videoDetails.thumbnail ||
        null;

      // Parse artist/title from video title if possible
      if (videoTitle.includes('-')) {
        const [potentialArtist, ...titleParts] = videoTitle.split('-');
        if (titleParts.length > 0) {
          artist = potentialArtist.trim();
          title = titleParts.join('-').trim();
        } else {
          title = videoTitle;
        }
      } else {
        title = videoTitle;
      }

      // Determine output filename
      const fileName = task.fileName
        ? `${self.outputPath}/${sanitize(task.fileName)}`
        : `${self.outputPath}/${videoTitle || info.videoId}.mp3`;

      // Configure stream options
      const streamOptions = {
        quality: self.youtubeVideoQuality,
        requestOptions: this.getRequestOptions(),
        ...(!self.allowWebm && {
          filter: (format) => format.container === 'mp4',
        }),
      };

      // Download and process stream
      const stream = ytdl.downloadFromInfo(info, streamOptions);

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        callback(err, null);
      });

      stream.on('response', (httpResponse) => {
        const str = progress({
          length: parseInt(httpResponse.headers['content-length']),
          time: self.progressTimeout,
        });

        str.on('progress', (progress) => {
          if (progress.percentage === 100) {
            resultObj.stats = {
              transferredBytes: progress.transferred,
              runtime: progress.runtime,
              averageSpeed: parseFloat(progress.speed.toFixed(2)),
            };
          }
          self.emit('progress', { videoId: task.videoId, progress });
        });

        // Configure output options
        const outputOptions = [
          '-id3v2_version',
          '4',
          '-metadata',
          `title=${title}`,
          '-metadata',
          `artist=${artist}`,
          ...(self.outputOptions || []),
        ];

        const audioBitrate =
          info.formats.find((f) => f.audioBitrate)?.audioBitrate || 192;

        new ffmpeg({ source: stream.pipe(str) })
          .audioBitrate(audioBitrate)
          .withAudioCodec('libmp3lame')
          .toFormat('mp3')
          .outputOptions(...outputOptions)
          .on('error', (err) => callback(err.message, null))
          .on('end', () => {
            callback(null, {
              ...resultObj,
              file: fileName,
              youtubeUrl: videoUrl,
              videoTitle,
              artist,
              title,
              thumbnail,
            });
          })
          .saveToFile(fileName);
      });
    } catch (err) {
      console.error('Download error:', err);
      callback(err);
    }
  }
}

module.exports = YoutubeMp3Downloader;
