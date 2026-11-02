import { AsYouType, getCountries, getCountryCallingCode, parseIncompletePhoneNumber, type CountryCode } from 'libphonenumber-js/min';

export type PhoneInputValue = { country: CountryCode; text: string; number: string };
export const initialPhoneInput: PhoneInputValue = { country: 'US', text: '', number: '' };

export function editPhoneNumber(text: string, previous: PhoneInputValue): PhoneInputValue {
  const input = parseIncompletePhoneNumber(text);
  const formatter = new AsYouType(previous.country);
  const formatted = formatter.input(input);
  const number = formatter.getNumberValue() ?? '';

  // Pasted international numbers select their own country; the calling code
  // belongs in the selector rather than appearing twice in the number field.
  if (input.startsWith('+')) {
    const callingCode = formatter.getCallingCode();
    const country = formatter.getCountry() ?? (callingCode
      ? getCountryCallingCode(previous.country) === callingCode ? previous.country
        : getCountries().find(code => getCountryCallingCode(code) === callingCode)
      : undefined);
    if (!country) return { country: previous.country, text: input, number: '' };
    return { country, text: formatter.getNumber()?.formatNational() ?? '', number };
  }

  // Keep deletions literal so removing an automatically inserted bracket or
  // space cannot immediately put it back and trap the backspace key.
  const display = !input ? '' : text.length < previous.text.length
    ? text.replace(/[^\d\s()-]/g, '') : formatted;
  return { country: previous.country, text: display, number };
}

export function changePhoneCountry(country: CountryCode, previous: PhoneInputValue): PhoneInputValue {
  const old = new AsYouType(previous.country);
  old.input(previous.text);
  const national = old.getNumber()?.nationalNumber ?? parseIncompletePhoneNumber(previous.text).replace(/^\+/, '');
  const next = editPhoneNumber(national, { country, text: '', number: '' });
  const formatter = new AsYouType(country);
  formatter.input(national);
  return { ...next, text: formatter.isPossible() ? formatter.getNumber()!.formatNational() : next.text };
}
