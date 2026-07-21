/**
 * Channel adapters (CLI today; Feishu IM for phone control).
 */
export type { AgentChannel, InboundMessage } from '../types';
export { FeishuChannel } from './feishu';
export type { FeishuInboundMessage, FeishuReceivePayload } from './feishu';
