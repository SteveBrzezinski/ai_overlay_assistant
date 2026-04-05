export type RealtimeTransportHandles = {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  audioSender: RTCRtpSender;
  audioElement: HTMLAudioElement;
};

type OpenRealtimeTransportOptions = {
  clientSecret: string;
  onRemoteTrack: (event: RTCTrackEvent, audioElement: HTMLAudioElement) => void;
  onMessage: (payload: string) => void;
  onConnectionStateChange: (state: RTCPeerConnectionState) => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
};

export async function openRealtimeTransport(
  options: OpenRealtimeTransportOptions,
): Promise<RealtimeTransportHandles> {
  const peerConnection = new RTCPeerConnection();
  const audioElement = new Audio();
  audioElement.autoplay = true;
  peerConnection.ontrack = (event) => {
    options.onRemoteTrack(event, audioElement);
  };
  peerConnection.onconnectionstatechange = () => {
    options.onConnectionStateChange(peerConnection.connectionState);
  };

  const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
  const dataChannel = peerConnection.createDataChannel('oai-events');
  dataChannel.addEventListener('message', (event) => {
    const rawPayload = typeof event.data === 'string' ? event.data : String(event.data);
    options.onMessage(rawPayload);
  });
  dataChannel.addEventListener('open', options.onDataChannelOpen);
  dataChannel.addEventListener('close', options.onDataChannelClose);

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${options.clientSecret}`,
      'Content-Type': 'application/sdp',
    },
  });

  if (!sdpResponse.ok) {
    const errorText = await sdpResponse.text();
    throw new Error(errorText || 'Failed to connect to OpenAI Realtime');
  }

  await peerConnection.setRemoteDescription({
    type: 'answer',
    sdp: await sdpResponse.text(),
  });

  await waitForDataChannelOpen(dataChannel, peerConnection);

  return {
    peerConnection,
    dataChannel,
    audioSender: audioTransceiver.sender,
    audioElement,
  };
}

async function waitForDataChannelOpen(
  dataChannel: RTCDataChannel,
  peerConnection: RTCPeerConnection,
  timeoutMs = 20000,
): Promise<void> {
  if (dataChannel.readyState === 'open') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while waiting for the Realtime data channel.'));
    }, timeoutMs);

    const cleanup = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timer);
      dataChannel.removeEventListener('open', handleOpen);
      dataChannel.removeEventListener('close', handleClose);
      dataChannel.removeEventListener('error', handleError);
      peerConnection.removeEventListener('connectionstatechange', handleConnectionStateChange);
    };

    const handleOpen = (): void => {
      cleanup();
      resolve();
    };

    const handleClose = (): void => {
      cleanup();
      reject(new Error('Realtime data channel closed before it was ready.'));
    };

    const handleError = (): void => {
      cleanup();
      reject(new Error('Realtime data channel reported an error.'));
    };

    const handleConnectionStateChange = (): void => {
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
        cleanup();
        reject(new Error(`Realtime peer connection ${peerConnection.connectionState}.`));
      }
    };

    dataChannel.addEventListener('open', handleOpen);
    dataChannel.addEventListener('close', handleClose);
    dataChannel.addEventListener('error', handleError);
    peerConnection.addEventListener('connectionstatechange', handleConnectionStateChange);

    if (dataChannel.readyState === 'open') {
      handleOpen();
    } else {
      handleConnectionStateChange();
    }
  });
}
