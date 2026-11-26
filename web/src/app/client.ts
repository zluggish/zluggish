import { t } from '../lib/i18n/index';
import { mount } from 'svelte';
import '../theme/theme.css';
import App from './App.svelte';

const target = document.getElementById('app');

if (!target) {
  throw new Error(t('app_client_missing_mount_element'));
}
mount(App, { target });
