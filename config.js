module.exports = function () {
  switch (process.env.NODE_ENV) {
    case 'production':
      return {
        REDIS_HOST: 'video-cut-tool',
        REDIS_PORT: 6379,
        REDIS_PASSWORD: '',
        API_ROOT: 'https://videocuttool.wmflabs.org/video-cut-tool-back-end',
      };

    default:
      return {
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: 6379,
        REDIS_PASSWORD: '',
        API_ROOT: 'http://localhost:4000',
      };
  }
};