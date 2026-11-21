// @ts-nocheck
import { createElement } from 'react'
import { defineWebExtension } from '@/sdk'

const Marker = () => createElement('span', null, 'hello-user-extension-marker')

export default defineWebExtension({
  slots: { 'statusline.left': [Marker] },
})
