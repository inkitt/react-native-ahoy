import { AsyncStorage } from 'react-native';

class Storage {
  async read(key) {
    try {
      const data = await AsyncStorage.getItem(key);

      return JSON.parse(data);
    } catch (err) {
      return this.onError(err);
    }
  }

  async write(key, data) {
    try {
      return AsyncStorage.setItem(key, JSON.stringify(data));
    } catch (err) {
      return this.onError(err);
    }
  }
}

const st = new Storage();

export default st;
