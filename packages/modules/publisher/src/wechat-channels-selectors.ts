export interface WeChatChannelsSelectorProfile {
  loginMarker: string;
  verificationMarker: string;
  fileInput: string;
  descriptionInput: string;
  coverInput: string;
  publishButton: string;
  successMarker: string;
  externalPostIdSelector?: string;
  externalPostIdAttribute?: string;
}

export const defaultWeChatChannelsSelectors: WeChatChannelsSelectorProfile = {
  loginMarker: 'text=登录', verificationMarker: 'text=验证', fileInput: 'input[type="file"]', descriptionInput: 'textarea', coverInput: 'input[type="file"][accept*="image"]', publishButton: 'button:has-text("发表")', successMarker: 'text=发布成功', externalPostIdSelector: '[data-post-id]', externalPostIdAttribute: 'data-post-id',
};
