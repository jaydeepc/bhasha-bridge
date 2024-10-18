import React, { useEffect, useRef, useCallback, useState } from 'react';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { X, Edit, Mic, Moon, Sun, Globe, Power, Settings, Zap } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import './ConsolePage.scss';

const LOCAL_RELAY_SERVER_URL: string = process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

const TRANSLATOR_INSTRUCTIONS = `
You are an AI mediator translator, tasked with facilitating seamless communication between two individuals who speak different languages. Your role is to accurately translate messages between these two languages, ensuring clear and effective communication. Follow these instructions carefully:

1. Begin by greeting the user and asking them to start speaking in their language.

2. After the user speaks, identify their language and ask for the language of the other person.

3. Once both languages are identified, inform the users that you're ready to begin translating.

4. For each subsequent message received, follow these steps:
   a. Identify the source language of the message.
   b. Translate the message into the target language.
   c. Present only the translated message in the target language, without any additional explanations or context.

5. Maintain neutrality in your translations. Do not add, omit, or alter the meaning of the original message. Translate idioms and cultural references as accurately as possible without additional explanations.

6. If a message is unclear, simply translate it as accurately as possible without asking for clarification.

7. Continue translating messages back and forth between the two languages until the conversation is complete or you're instructed to stop.

8. Your responses should only contain the translated message, nothing else.

Begin the translation process by greeting the user and asking them to start speaking.
`;

export function ConsolePage() {
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  const wavRecorderRef = useRef<WavRecorder>(new WavRecorder({ sampleRate: 24000 }));
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(new WavStreamPlayer({ sampleRate: 24000 }));
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  const [items, setItems] = useState<ItemType[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    setIsConnected(true);
    setItems(client.conversation.getItems());

    await wavRecorder.begin();
    await wavStreamPlayer.connect();
    await client.connect();
    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Start the translation process.`,
      },
    ]);

    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setItems([]);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  };

  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  };

  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    setCanPushToTalk(value === 'none');
  };

  const toggleDarkMode = () => {
    setIsDarkMode(!isDarkMode);
  };

  const toggleSettings = () => {
    setIsSettingsOpen(!isSettingsOpen);
  };

  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  useEffect(() => {
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    client.updateSession({ instructions: TRANSLATOR_INSTRUCTIONS });
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      client.reset();
    };
  }, []);

  return (
    <div className={`console-page ${isDarkMode ? 'dark-mode' : ''}`}>
      <header className="header">
        <div className="logo-container">
          <Globe size={32} className="logo-icon" />
          <div className="logo-text">
            <h1 className="logo">Bhasha Bridge</h1>
            <p className="creator">Created by Jaydeep Chakrabarty</p>
          </div>
        </div>
        <div className="header-controls">
          <button className="settings-toggle" onClick={toggleSettings}>
            <Settings size={20} />
          </button>
          <button className="theme-toggle" onClick={toggleDarkMode}>
            {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
      </header>
      <main className="main-content">
        <div className="sidebar">
          <div className="control-panel">
            <Toggle
              defaultValue={false}
              labels={['Manual', 'Auto']}
              values={['none', 'server_vad']}
              onChange={(_, value) => changeTurnEndType(value)}
            />
            <Button
              icon={isConnected ? Power : Zap}
              label={isConnected ? 'Disconnect' : 'Connect'}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={isConnected ? disconnectConversation : connectConversation}
              className="connection-button"
            />
          </div>
          {isSettingsOpen && (
            <div className="settings-panel">
              {!LOCAL_RELAY_SERVER_URL && (
                <Button
                  icon={Edit}
                  iconPosition="end"
                  buttonStyle="flush"
                  label={`API Key: ${apiKey.slice(0, 3)}...`}
                  onClick={resetAPIKey}
                />
              )}
            </div>
          )}
        </div>
        <div className="conversation-container">
          <div className="conversation" data-conversation-content>
            {!items.length && (
              <div className="awaiting-connection">
                <p>Connect Languages, Bridge Cultures</p>
                <p>Start your journey with Bhasha Bridge</p>
              </div>
            )}
            {items.map((item) => (
              <div key={item.id} className={`message ${item.role}`}>
                <div className="message-content">
                  {item.formatted.transcript || item.formatted.text || '(truncated)'}
                </div>
                {item.formatted.file && (
                  <audio src={item.formatted.file.url} controls className="audio-player" />
                )}
                <button className="delete-message" onClick={() => deleteConversationItem(item.id)}>
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="input-container">
          {isConnected && canPushToTalk && (
            <Button
              icon={Mic}
              label={isRecording ? 'Release to send' : 'Hold to speak'}
              buttonStyle={isRecording ? 'alert' : 'regular'}
              disabled={!isConnected || !canPushToTalk}
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              className="speak-button"
            />
          )}
        </div>
      </main>
    </div>
  );
}
