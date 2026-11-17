// Where the running app advertises itself to the hook script.
const os = require('os');
const path = require('path');

const home = process.env.HUDDLE_HOME || path.join(os.homedir(), '.agent-huddle');

module.exports = {
  home,
  runtimeFile: path.join(home, 'runtime.json'),
  configFile: path.join(home, 'config.json'),
};
