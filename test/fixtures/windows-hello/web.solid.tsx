import { defineWebExtension } from '@/sdk/solid'

const Marker = () => <span>hello-user-extension-marker</span>

export default defineWebExtension({
  slots: { 'statusline.left': [Marker] },
})
