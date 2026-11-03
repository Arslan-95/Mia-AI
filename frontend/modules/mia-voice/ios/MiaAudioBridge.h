#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
NS_ASSUME_NONNULL_BEGIN

// Cocoa exceptions must be caught on the Objective-C side of the Swift boundary.
@interface MiaAudioBridge : NSObject
+ (nullable NSError *)startEngine:(AVAudioEngine *)engine player:(AVAudioPlayerNode *)player tap:(AVAudioNodeTapBlock)tap NS_SWIFT_NAME(start(_:player:tap:));
+ (nullable NSError *)resumeEngine:(AVAudioEngine *)engine NS_SWIFT_NAME(resume(_:));
+ (nullable NSError *)stopEngine:(nullable AVAudioEngine *)engine player:(nullable AVAudioPlayerNode *)player tapped:(BOOL)tapped NS_SWIFT_NAME(stop(_:player:tapped:));
+ (nullable NSError *)stopPlayer:(nullable AVAudioPlayerNode *)player NS_SWIFT_NAME(stopPlayback(_:));
+ (nullable NSError *)playPCM:(NSData *)data player:(AVAudioPlayerNode *)player completion:(void (^)(void))completion NS_SWIFT_NAME(play(_:player:completion:));
+ (nullable AVAudioPCMBuffer *)copyInput:(AVAudioPCMBuffer *)input NS_SWIFT_NAME(copyInput(_:));
+ (NSDictionary<NSString *, id> *)diagnostics;
+ (void)recordEvent:(NSString *)stage detail:(NSDictionary<NSString *, id> *)detail NS_SWIFT_NAME(record(_:detail:));
- (nullable NSData *)convertInput:(AVAudioPCMBuffer *)input NS_SWIFT_NAME(convert(_:));
- (void)reset;
@end
NS_ASSUME_NONNULL_END
