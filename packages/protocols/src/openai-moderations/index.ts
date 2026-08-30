// https://developers.openai.com/api/reference/resources/moderations/methods/create
export interface OpenAIModerationTextInput {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface OpenAIModerationImageUrlInput {
  type: 'image_url';
  image_url: {
    url: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type OpenAIModerationInput =
  | string
  | string[]
  | (OpenAIModerationTextInput | OpenAIModerationImageUrlInput)[];

export interface OpenAIModerationsPayload {
  model?: string;
  input: OpenAIModerationInput;
  [key: string]: unknown;
}
