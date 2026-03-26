import React, { useState, useRef, useEffect } from 'react';
import '../styles/ChatWindow.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface ChatWindowProps {
  isOpen: boolean;
  onClose: () => void;
  isMuted?: boolean;
  onSendMessage?: (message: string) => Promise<void>;
}

export const ChatWindow: React.FC<ChatWindowProps> = ({
  isOpen,
  onClose,
  isMuted = false,
  onSendMessage,
}) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'Hallo! Ich bin dein AI-Assistent. Wie kann ich dir heute helfen?',
      timestamp: new Date(),
    },
  ]);
  
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'de-DE';

      recognitionRef.current.onstart = () => {
        setIsListening(true);
      };

      recognitionRef.current.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join('');
        setInputValue(transcript);
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  const handleVoiceInput = () => {
    if (recognitionRef.current) {
      if (isListening) {
        recognitionRef.current.stop();
      } else {
        recognitionRef.current.start();
      }
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    // Add user message
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);

    try {
      if (onSendMessage) {
        await onSendMessage(inputValue);
      }

      // Simulated response (replace with actual API call)
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Ich habe deine Nachricht erhalten und arbeite daran, dir zu helfen.',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="chat-overlay">
      <div className="chat-window">
        <div className="chat-header">
          <span className="chat-title">AI Assistant</span>
          <button className="chat-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="chat-messages">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`message message-${message.role}`}
            >
              <div className="message-content">
                {message.content}
              </div>
              <div className="message-time">
                {message.timestamp.toLocaleTimeString('de-DE', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="message message-assistant">
              <div className="message-content">
                <span className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <div className="input-wrapper">
            <input
              type="text"
              className="chat-input"
              placeholder="Schreib eine Frage..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              disabled={isLoading}
            />

            <button
              className={`voice-btn ${isListening ? 'listening' : ''}`}
              onClick={handleVoiceInput}
              title={isListening ? 'Stop listening' : 'Start voice input'}
            >
              {isListening ? '🎤' : '🎙️'}
            </button>

            <button
              className="send-btn"
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || isLoading}
              title="Send message"
            >
              ➤
            </button>
          </div>

          {isMuted && (
            <div className="muted-notice">
              💬 AI ist auf stumm. Antworten erscheinen hier.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
